/**
 * See: docs/system-design.md § Cold start (backfill from order history)
 * Related: docs/database-design.md (ProtectedOffer.coldStart*),
 *          docs/webhook-spec.md §5 (RedemptionRecord + shard_append),
 *          docs/scoring-spec.md §5.2 (post-order hashing)
 *
 * Cold-start backfill job. When a merchant attaches a code to a protected
 * offer, we query Shopify admin orders that previously used that code and
 * replay them through the normalize → hash → (encrypt) → RedemptionRecord →
 * shard_append pipeline. Once this completes, Promo Guard has historical
 * context for the next checkout / order.
 *
 * The job is checkpointed: the payload carries a `codeIndex` and `cursor` so
 * throttle-triggered retries resume exactly where they left off. Pagination is
 * 250/page (Shopify max), bounded by `MAX_PAGES_PER_RUN` so a very large shop
 * re-enqueues itself rather than blocking a worker slot indefinitely.
 *
 * Privacy: we never log decrypted PII. The only plaintext that survives the
 * function body is the canonicalised value used to compute a hash, and it's
 * dropped after the `RedemptionRecord.create` call. The DEK is zeroed in the
 * `finally` block.
 */
import type { Shop } from "@prisma/client";

import prisma from "../db.server.js";
import { encrypt, loadKek, unwrapDek } from "../lib/crypto.server.js";
import {
  enqueueJob,
  type JobHandler,
  type JobHandlerCtx,
} from "../lib/jobs.server.js";
import { addressTrigrams, fullKey } from "../lib/normalize/address.server.js";
import {
  canonicalEmail,
  emailTrigrams,
} from "../lib/normalize/email.server.js";
import { ipPrefixKey } from "../lib/normalize/ip.server.js";
import { canonicalPhone } from "../lib/normalize/phone.server.js";
import { computeSketch } from "../lib/minhash.server.js";
import { hashForLookup, hashToHex } from "../lib/hash.server.js";
import { resolveShopGid } from "../lib/shop.server.js";
import { unauthenticated } from "../shopify.server.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Shopify orders(...) max page size. */
export const PAGE_SIZE = 250;

/**
 * Upper bound on the number of pages consumed per job run. When reached we
 * re-enqueue a continuation job carrying the current checkpoint. This keeps
 * any one shop from starving others on the queue, and gives the Shopify
 * throttle bucket a chance to refill between chunks.
 */
export const MAX_PAGES_PER_RUN = 20;

/**
 * How many orders we batch before calling `ctx.updateProgress`. Progress rows
 * are durable; spamming them is cheap but not free.
 */
const PROGRESS_CHUNK = 25;

// ---------------------------------------------------------------------------
// Payload + enqueue helper
// ---------------------------------------------------------------------------

export interface ColdStartPayload {
  protectedOfferId: string;
  /** Index into the offer's code list (stable sort by addedAt). */
  codeIndex?: number;
  /** Cursor within the current code's orders() pagination. */
  cursor?: string | null;
}

function isPayload(x: unknown): x is ColdStartPayload {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as { protectedOfferId?: unknown }).protectedOfferId === "string"
  );
}

/**
 * Enqueue a cold-start job for the given offer. Idempotent-ish: the handler
 * itself is safe to run multiple times because RedemptionRecord.create relies
 * on the `(shopId, orderGid, protectedOfferId)` unique index.
 */
export async function enqueueColdStart(args: {
  shopId: string;
  protectedOfferId: string;
}): Promise<void> {
  await enqueueJob({
    shopId: args.shopId,
    type: "cold_start",
    payload: {
      protectedOfferId: args.protectedOfferId,
      codeIndex: 0,
      cursor: null,
    } satisfies ColdStartPayload,
  });
}

// ---------------------------------------------------------------------------
// Admin GraphQL — orders(query: "discount_code:X")
// ---------------------------------------------------------------------------

const ORDERS_BY_DISCOUNT_CODE = /* GraphQL */ `
  query OrdersByDiscountCode($query: String!, $cursor: String, $first: Int!) {
    orders(
      query: $query
      first: $first
      after: $cursor
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          email
          phone
          clientIp
          customer {
            id
            phone
          }
          discountCodes
          shippingAddress {
            address1
            address2
            city
            zip
            countryCodeV2
          }
          billingAddress {
            address1
            address2
            city
            zip
            countryCodeV2
          }
        }
      }
    }
  }
`;

interface OrderAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
}

interface OrderNode {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  clientIp?: string | null;
  customer?: { id?: string | null; phone?: string | null } | null;
  discountCodes?: string[] | null;
  shippingAddress?: OrderAddress | null;
  billingAddress?: OrderAddress | null;
}

interface OrdersQueryData {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: OrderNode }>;
  };
}

interface GqlResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

interface ResponseLike {
  status?: number;
  json: () => Promise<unknown>;
}

function isResponseLike(x: unknown): x is ResponseLike {
  return !!x && typeof (x as ResponseLike).json === "function";
}

function isThrottled(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const errs = (body as GqlResponse<unknown>).errors;
  if (!Array.isArray(errs)) return false;
  for (const e of errs) {
    if (e?.extensions?.code === "THROTTLED") return true;
    if (typeof e?.message === "string" && /throttled/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

export class ColdStartThrottledError extends Error {
  constructor(message = "Shopify Admin throttled cold-start orders query") {
    super(message);
    this.name = "ColdStartThrottledError";
  }
}

async function fetchOrdersPage(
  client: unknown,
  code: string,
  cursor: string | null,
): Promise<OrdersQueryData["orders"]> {
  const call = client as (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<unknown>;
  const raw = await call(ORDERS_BY_DISCOUNT_CODE, {
    variables: {
      query: `discount_code:${code}`,
      cursor,
      first: PAGE_SIZE,
    },
  });
  const body: GqlResponse<OrdersQueryData> = isResponseLike(raw)
    ? ((await raw.json()) as GqlResponse<OrdersQueryData>)
    : (raw as GqlResponse<OrdersQueryData>);
  if (isThrottled(body)) {
    throw new ColdStartThrottledError();
  }
  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `cold-start orders query failed: ${body.errors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
  return (
    body.data?.orders ?? {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [],
    }
  );
}

// ---------------------------------------------------------------------------
// Hashing / sketches (mirrors handle-orders-paid + scorePostOrder)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function lookupHex(tag: string, value: string, salt: Uint8Array): string {
  return hashToHex(hashForLookup(tag, new TextEncoder().encode(value), salt));
}

function addressFullKeyOrNull(addr: OrderAddress | null): string | null {
  if (!addr) return null;
  return fullKey({
    line1: addr.address1 ?? "",
    line2: addr.address2 ?? "",
    zip: addr.zip ?? "",
    countryCode: addr.countryCodeV2 ?? "",
  });
}

function padSketch(
  s: number[] | undefined,
): [number, number, number, number] {
  const a = s ?? [];
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
}

interface BackfillSignals {
  hashes: Record<string, string>;
  canonEmail: string | null;
  canonPhone: string | null;
  /** Primary (shipping-preferred) address used for MinHash + ciphertext. */
  addr: OrderAddress | null;
  /** Billing address when distinct from shipping; null otherwise. */
  billingAddr: OrderAddress | null;
  ip: string | null;
  emailSketch?: number[];
  addressSketch?: number[];
}

function extractSignals(
  order: OrderNode,
  saltHex: string,
): BackfillSignals {
  const salt = hexToBytes(saltHex);

  const canonEmail = order.email ? canonicalEmail(order.email) : null;
  const canonPhone = canonicalPhone(
    order.phone ?? order.customer?.phone ?? null,
    null,
  );
  const shippingAddr = order.shippingAddress ?? null;
  const billingAddrRaw = order.billingAddress ?? null;
  // Prefer shipping as the "primary" address for ciphertext + sketches.
  const addr = shippingAddr ?? billingAddrRaw;
  const ip = order.clientIp ?? null;

  const hashes: Record<string, string> = {};

  if (canonEmail) {
    hashes["email_canonical"] = lookupHex("email_canonical", canonEmail, salt);
  }
  if (canonPhone) {
    hashes["phone"] = lookupHex("phone", canonPhone, salt);
  }

  const fullKeyStr = addressFullKeyOrNull(addr) ?? "";
  if (fullKeyStr) {
    hashes["address_full"] = lookupHex("addr_full", fullKeyStr, salt);
  }

  // Billing: only emit a second hash when billing exists AND its full-key
  // differs from the primary. Collapses the common (shipping == billing) case.
  const billingFullKeyStr = shippingAddr
    ? addressFullKeyOrNull(billingAddrRaw)
    : null;
  const billingAddr =
    billingFullKeyStr && billingFullKeyStr !== fullKeyStr
      ? billingAddrRaw
      : null;
  if (billingAddr && billingFullKeyStr) {
    hashes["billing_address_full"] = lookupHex(
      "addr_full",
      billingFullKeyStr,
      salt,
    );
  }

  const ipPrefix = ip ? ipPrefixKey(ip) : null;
  if (ipPrefix) {
    hashes[ipPrefix.tag] = lookupHex(ipPrefix.tag, ipPrefix.key, salt);
  }

  const emailSketch = canonEmail
    ? computeSketch(
        emailTrigrams(canonEmail).map((t) => new TextDecoder().decode(t)),
        salt,
      )
    : undefined;

  const parts = fullKeyStr.split("|");
  const addressSketch = addr
    ? computeSketch(
        addressTrigrams(parts[0] ?? "", parts[2] ?? "", parts[3] ?? ""),
        salt,
      )
    : undefined;

  return {
    hashes,
    canonEmail,
    canonPhone,
    addr,
    billingAddr,
    ip,
    emailSketch,
    addressSketch,
  };
}

// ---------------------------------------------------------------------------
// Record insertion + shard_append enqueue
// ---------------------------------------------------------------------------

interface InsertArgs {
  shop: Shop;
  protectedOfferId: string;
  codeUsed: string;
  order: OrderNode;
  dek: Buffer;
  shopGid: string;
}

/**
 * Returns true if we inserted a new row, false if it already existed.
 * Existing rows short-circuit so repeated cold-start runs are idempotent.
 */
async function backfillOrder(args: InsertArgs): Promise<boolean> {
  const { shop, protectedOfferId, codeUsed, order, dek, shopGid } = args;

  // Idempotency: skip orders we already have for this (shop, offer).
  const existing = await prisma.redemptionRecord.findUnique({
    where: {
      shopId_orderGid_protectedOfferId: {
        shopId: shop.id,
        orderGid: order.id,
        protectedOfferId,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  const sig = extractSignals(order, shop.salt);

  const created = await prisma.redemptionRecord.create({
    data: {
      shopId: shop.id,
      protectedOfferId,
      orderGid: order.id,
      orderName: order.name ?? "",
      codeUsed,
      customerGid: order.customer?.id ?? null,

      emailCiphertext: sig.canonEmail ? encrypt(sig.canonEmail, dek) : null,
      phoneCiphertext: sig.canonPhone ? encrypt(sig.canonPhone, dek) : null,
      addressCiphertext: sig.addr ? encrypt(JSON.stringify(sig.addr), dek) : null,
      billingAddressCiphertext: sig.billingAddr
        ? encrypt(JSON.stringify(sig.billingAddr), dek)
        : null,
      ipCiphertext: sig.ip ? encrypt(sig.ip, dek) : null,

      phoneHash: sig.hashes["phone"] ?? null,
      emailCanonicalHash: sig.hashes["email_canonical"] ?? null,
      addressFullHash: sig.hashes["address_full"] ?? null,
      billingAddressFullHash: sig.hashes["billing_address_full"] ?? null,
      ipHash24:
        sig.hashes["ip_v4_24"] ?? sig.hashes["ip_v6_48"] ?? null,

      emailMinhashSketch: sig.emailSketch
        ? JSON.stringify(sig.emailSketch)
        : null,
      addressMinhashSketch: sig.addressSketch
        ? JSON.stringify(sig.addressSketch)
        : null,
    },
  });

  await enqueueJob({
    shopId: shop.id,
    type: "shard_append",
    payload: {
      shopDomain: shop.shopDomain,
      shopGid,
      saltHex: shop.salt,
      defaultCountryCc: null,
      entry: {
        ts: Math.floor(created.createdAt.getTime() / 1000),
        phone: sig.hashes["phone"] ?? "",
        email: sig.hashes["email_canonical"] ?? "",
        addr_full: sig.hashes["address_full"] ?? "",
        addr_house: sig.hashes["address_house"] ?? "",
        ip24: sig.hashes["ip_v4_24"] ?? sig.hashes["ip_v6_48"] ?? "",
        device: sig.hashes["device"] ?? "",
        email_sketch: padSketch(sig.emailSketch),
        addr_sketch: padSketch(sig.addressSketch),
      },
    },
  });

  return true;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleColdStart: JobHandler<unknown> = async (payload, ctx) => {
  if (!isPayload(payload)) {
    throw new Error("cold_start: missing protectedOfferId in payload");
  }
  const { protectedOfferId } = payload;

  const shop = await prisma.shop.findUnique({ where: { id: ctx.shopId } });
  if (!shop) return; // shop was deleted between enqueue and run

  const offer = await prisma.protectedOffer.findUnique({
    where: { id: protectedOfferId },
    include: {
      codes: {
        where: { archivedAt: null },
        orderBy: { addedAt: "asc" },
      },
    },
  });

  // Offer gone or archived → nothing to do. Don't crash — the queue shouldn't
  // keep retrying a job for a deleted offer.
  if (!offer || offer.archivedAt || offer.shopId !== shop.id) return;
  if (offer.codes.length === 0) {
    await prisma.protectedOffer.update({
      where: { id: offer.id },
      data: { coldStartStatus: "complete", coldStartDone: 0, coldStartTotal: 0 },
    });
    return;
  }

  // First invocation marks running. Subsequent (continuation) invocations
  // leave the status alone.
  if (offer.coldStartStatus !== "running") {
    await prisma.protectedOffer.update({
      where: { id: offer.id },
      data: { coldStartStatus: "running" },
    });
  }

  const { admin } = await unauthenticated.admin(shop.shopDomain);
  const shopGid = await resolveShopGid(shop, admin);
  const kek = loadKek();
  const dek = unwrapDek(shop.encryptionKey, kek);

  let codeIndex = payload.codeIndex ?? 0;
  let cursor: string | null = payload.cursor ?? null;
  let pagesThisRun = 0;
  let backfilledThisRun = 0;

  try {
    while (codeIndex < offer.codes.length) {
      const currentCode = offer.codes[codeIndex];
      const code = currentCode.codeUpper;

      // Page through this code's orders until either (a) done, (b) we hit
      // MAX_PAGES_PER_RUN and re-enqueue, or (c) Shopify throttles us and we
      // throw (queue backoff reschedules).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (pagesThisRun >= MAX_PAGES_PER_RUN) {
          await scheduleContinuation(ctx, {
            shopId: shop.id,
            protectedOfferId,
            codeIndex,
            cursor,
          });
          return;
        }
        const page = await fetchOrdersPage(admin.graphql, code, cursor);
        pagesThisRun++;

        for (const edge of page.edges) {
          const inserted = await backfillOrder({
            shop,
            protectedOfferId,
            codeUsed: code,
            order: edge.node,
            dek,
            shopGid,
          });
          if (inserted) {
            backfilledThisRun++;
            if (backfilledThisRun % PROGRESS_CHUNK === 0) {
              await bumpProgress(ctx, offer.id, PROGRESS_CHUNK);
            }
          }
        }

        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
          break;
        }
        cursor = page.pageInfo.endCursor;
      }

      // Done with this code — move to the next one from the top.
      codeIndex++;
      cursor = null;
    }

    // Flush any residual progress not yet committed.
    const residue = backfilledThisRun % PROGRESS_CHUNK;
    if (residue > 0) {
      await bumpProgress(ctx, offer.id, residue);
    }

    await prisma.protectedOffer.update({
      where: { id: offer.id },
      data: { coldStartStatus: "complete" },
    });
  } finally {
    dek.fill(0);
  }
};

async function bumpProgress(
  ctx: JobHandlerCtx,
  offerId: string,
  delta: number,
): Promise<void> {
  const updated = await prisma.protectedOffer.update({
    where: { id: offerId },
    data: { coldStartDone: { increment: delta } },
    select: { coldStartDone: true, coldStartTotal: true },
  });
  await ctx.updateProgress(updated.coldStartDone, updated.coldStartTotal);
}

async function scheduleContinuation(
  ctx: JobHandlerCtx,
  args: {
    shopId: string;
    protectedOfferId: string;
    codeIndex: number;
    cursor: string | null;
  },
): Promise<void> {
  await enqueueJob({
    shopId: args.shopId,
    type: "cold_start",
    payload: {
      protectedOfferId: args.protectedOfferId,
      codeIndex: args.codeIndex,
      cursor: args.cursor,
    } satisfies ColdStartPayload,
  });
  // No progress change — continuation picks up counters in DB.
  void ctx;
}
