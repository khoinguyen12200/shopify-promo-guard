/**
 * See: docs/webhook-spec.md §5 (orders/paid handler)
 *      docs/scoring-spec.md §5.2 (post-order scoring)
 *
 * Worker-side processing of an `orders/paid` Shopify webhook.
 *
 * Flow:
 *   1. Parse the (already-validated) order JSON into a small typed view.
 *   2. Find any `ProtectedOffer` whose codes overlap with the order's
 *      discount_codes. If none → no-op.
 *   3. For each match: normalize identity signals, encrypt PII, write a
 *      RedemptionRecord, run scorePostOrder() which queries existing
 *      records, and — if the score crosses MEDIUM/HIGH thresholds — write
 *      a FlaggedOrder, create a Shopify order risk assessment, tag the
 *      order, and enqueue a `shard_append` sub-job.
 *
 * Admin GraphQL is reached via `unauthenticated.admin(shopDomain)` since
 * this runs in the worker process with no incoming request context. We
 * keep the per-shop DEK in scope only for as long as the encrypt() calls
 * need it, then zero it.
 */

import type { Shop } from "@prisma/client";

import prisma from "../db.server.js";
import {
  orderRiskAssessmentCreate,
  tagsAdd,
} from "../lib/admin-graphql.server.js";
import { encrypt, loadKek, unwrapDek } from "../lib/crypto.server.js";
import { enqueueJob, type JobHandler } from "../lib/jobs.server.js";
import { addressTrigrams, fullKey } from "../lib/normalize/address.server.js";
import { normalizeCardNameLast4 } from "../lib/normalize/card.server.js";
import {
  canonicalEmail,
  emailTrigrams,
} from "../lib/normalize/email.server.js";
import { canonicalPhone } from "../lib/normalize/phone.server.js";
import { computeSketch } from "../lib/minhash.server.js";
import { scorePostOrder } from "../lib/scoring/score.server.js";
import { resolveShopGid } from "../lib/shop.server.js";
import { unauthenticated } from "../shopify.server.js";

// ---------------------------------------------------------------------------
// Payload typing — the webhook route hands us the parsed JSON verbatim. We
// keep this loose because Shopify's payload is wide and we only read a few
// fields.
// ---------------------------------------------------------------------------

export interface OrdersPaidPayload {
  shopDomain: string;
  orderJson: unknown;
}

interface OrderAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  country_code?: string | null;
}

interface OrderJson {
  admin_graphql_api_id?: string;
  id?: number | string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  browser_ip?: string | null;
  client_details?: { browser_ip?: string | null } | null;
  discount_codes?: Array<{ code?: string }>;
  shipping_address?: OrderAddress | null;
  billing_address?: OrderAddress | null;
  customer?: {
    id?: number | string;
    admin_graphql_api_id?: string;
    phone?: string | null;
  } | null;
}

function isPayload(x: unknown): x is OrdersPaidPayload {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as { shopDomain?: unknown }).shopDomain === "string" &&
    "orderJson" in (x as object)
  );
}

function asOrder(x: unknown): OrderJson {
  return (x ?? {}) as OrderJson;
}

function pickIp(o: OrderJson): string | undefined {
  return o.browser_ip ?? o.client_details?.browser_ip ?? undefined;
}

function pickAddress(o: OrderJson): OrderAddress | null {
  return o.shipping_address ?? o.billing_address ?? null;
}

function pickBillingAddress(o: OrderJson): OrderAddress | null {
  // When we have both shipping and billing, the billing slot carries the
  // billing row. If only billing is set, it already became the primary via
  // pickAddress — leave the billing slot null.
  if (!o.shipping_address) return null;
  return o.billing_address ?? null;
}

function customerGid(o: OrderJson): string | undefined {
  return o.customer?.admin_graphql_api_id ?? undefined;
}

function orderGid(o: OrderJson): string | undefined {
  return o.admin_graphql_api_id;
}

// ---------------------------------------------------------------------------
// Card name + last4 fetch — the orders/paid webhook payload doesn't expose
// the cardholder name, so we query the order's transactions via Admin
// GraphQL. Requires read_orders scope (already granted).
// ---------------------------------------------------------------------------

const ORDER_CARD_DETAILS_QUERY = /* GraphQL */ `
  query OrderCardDetails($id: ID!) {
    order(id: $id) {
      transactions(first: 5) {
        kind
        status
        paymentDetails {
          ... on CardPaymentDetails {
            name
            number
          }
        }
      }
    }
  }
`;

type GqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type CardTxn = {
  kind?: string | null;
  status?: string | null;
  paymentDetails?: { name?: string | null; number?: string | null } | null;
};

type OrderCardDetailsData = {
  order: { transactions: CardTxn[] | null } | null;
};

async function fetchOrderCardNameLast4(
  graphql: (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<unknown>,
  orderId: string,
): Promise<string | null> {
  let body: GqlResponse<OrderCardDetailsData> | undefined;
  try {
    const raw = await graphql(ORDER_CARD_DETAILS_QUERY, {
      variables: { id: orderId },
    });
    if (!raw) return null;
    body =
      typeof (raw as { json?: unknown }).json === "function"
        ? ((await (raw as { json: () => Promise<unknown> }).json()) as GqlResponse<OrderCardDetailsData>)
        : (raw as GqlResponse<OrderCardDetailsData>);
  } catch (err) {
    console.error(
      "[orders_paid] fetchOrderCardNameLast4 failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const txns = body?.data?.order?.transactions ?? [];
  for (const t of txns) {
    const status = (t.status ?? "").toUpperCase();
    if (status && status !== "SUCCESS") continue;
    const card = t.paymentDetails;
    if (!card) continue;
    const digits = (card.number ?? "").match(/\d/g) ?? [];
    if (digits.length < 4) continue;
    const last4 = digits.slice(-4).join("");
    const key = normalizeCardNameLast4(card.name ?? "", last4);
    if (key) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleOrdersPaid: JobHandler<unknown> = async (payload, ctx) => {
  if (!isPayload(payload)) {
    throw new Error("orders_paid: missing shopDomain/orderJson in payload");
  }

  const shop = await prisma.shop.findUnique({ where: { id: ctx.shopId } });
  if (!shop) return; // shop deleted between enqueue and run — nothing to do

  const order = asOrder(payload.orderJson);
  const oid = orderGid(order);
  const oname = order.name ?? "";

  // 1. Codes used in the order (uppercased + de-duplicated).
  const codesUpper = Array.from(
    new Set(
      (order.discount_codes ?? [])
        .map((d) => (d?.code ?? "").trim().toUpperCase())
        .filter((c) => c.length > 0),
    ),
  );
  if (codesUpper.length === 0 || !oid) return;

  // 2. Find protected codes for this shop matching ANY of those codes.
  const matchedCodes = await prisma.protectedCode.findMany({
    where: {
      codeUpper: { in: codesUpper },
      protectedOffer: { shopId: shop.id, status: "active" },
    },
    include: { protectedOffer: true },
  });
  if (matchedCodes.length === 0) return;

  // De-duplicate by offer (a single order should produce one
  // RedemptionRecord per offer even if it used multiple codes from the same
  // offer). Keep the first matching code for the codeUsed column.
  const byOffer = new Map<
    string,
    { codeUsed: string; offer: (typeof matchedCodes)[number]["protectedOffer"] }
  >();
  for (const m of matchedCodes) {
    if (!byOffer.has(m.protectedOfferId)) {
      byOffer.set(m.protectedOfferId, {
        codeUsed: m.codeUpper,
        offer: m.protectedOffer,
      });
    }
  }

  // 3. Open admin client + decrypt DEK once for the duration of this handler.
  const { admin } = await unauthenticated.admin(shop.shopDomain);
  const shopGid = await resolveShopGid(shop, admin);
  const kek = loadKek();
  const dek = unwrapDek(shop.encryptionKey, kek);

  try {
    for (const [protectedOfferId, { codeUsed }] of byOffer) {
      await processOfferMatch({
        shop,
        protectedOfferId,
        codeUsed,
        order,
        oid,
        oname,
        dek,
        adminClient: admin,
        shopGid,
      });
    }
  } finally {
    dek.fill(0);
  }
};

interface ProcessArgs {
  shop: Shop;
  protectedOfferId: string;
  codeUsed: string;
  order: OrderJson;
  oid: string;
  oname: string;
  dek: Buffer;
  adminClient: { graphql: unknown };
  shopGid: string;
}

async function processOfferMatch(args: ProcessArgs): Promise<void> {
  const { shop, protectedOfferId, codeUsed, order, oid, oname, dek } = args;
  const adminClient = args.adminClient as { graphql: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

  // ---- Normalize signals -------------------------------------------------
  const addr = pickAddress(order);
  const billingAddrRaw = pickBillingAddress(order);
  const customerPhoneRaw = order.phone ?? order.customer?.phone ?? null;
  const ip = pickIp(order);

  const canonEmail = order.email ? canonicalEmail(order.email) : null;
  const canonPhone = canonicalPhone(customerPhoneRaw, null);

  const addressLine1 = addr?.address1 ?? "";
  const addressLine2 = addr?.address2 ?? "";
  const addressZip = addr?.zip ?? "";
  const addressCountry = addr?.country_code ?? "";

  // ---- Sketches ----------------------------------------------------------
  const saltBytes = hexToBytes(shop.salt);

  const emailSketch = canonEmail
    ? computeSketch(
        emailTrigrams(canonEmail).map((tri) =>
          new TextDecoder().decode(tri),
        ),
        saltBytes,
      )
    : undefined;

  const fullKeyStr = addr
    ? fullKey({
        line1: addressLine1,
        line2: addressLine2,
        zip: addressZip,
        countryCode: addressCountry,
      })
    : "";
  const addressSketch = addr
    ? computeSketch(
        addressTrigrams(
          // normalize-once via fullKey to mirror what scoring uses, but the
          // trigram input is just the normalized line1+zip+cc.
          fullKeyStr.split("|")[0] ?? "",
          fullKeyStr.split("|")[2] ?? "",
          fullKeyStr.split("|")[3] ?? "",
        ),
        saltBytes,
      )
    : undefined;

  // Billing: only pass when billing differs from primary (§ billing slot).
  const billingFullKeyStr = billingAddrRaw
    ? fullKey({
        line1: billingAddrRaw.address1 ?? "",
        line2: billingAddrRaw.address2 ?? "",
        zip: billingAddrRaw.zip ?? "",
        countryCode: billingAddrRaw.country_code ?? "",
      })
    : "";
  const billingDiffers =
    billingAddrRaw != null && billingFullKeyStr !== fullKeyStr;
  const billingAddrForStorage = billingDiffers ? billingAddrRaw : null;

  // Card: requires an Admin GraphQL round-trip — webhook payload has no name.
  const cardNameLast4 = await fetchOrderCardNameLast4(adminClient.graphql, oid);

  // ---- Score (also computes hashes we'll persist) -----------------------
  const scoreResult = await scorePostOrder({
    shopSalt: shop.salt,
    protectedOfferId,
    signals: {
      email: canonEmail ?? undefined,
      phone: canonPhone ?? undefined,
      addressLine1,
      addressLine2,
      addressZip,
      addressCountry,
      billingAddressLine1: billingDiffers
        ? (billingAddrRaw?.address1 ?? "")
        : undefined,
      billingAddressLine2: billingDiffers
        ? (billingAddrRaw?.address2 ?? "")
        : undefined,
      billingAddressZip: billingDiffers
        ? (billingAddrRaw?.zip ?? "")
        : undefined,
      billingAddressCountry: billingDiffers
        ? (billingAddrRaw?.country_code ?? "")
        : undefined,
      ip,
      cardNameLast4: cardNameLast4 ?? undefined,
    },
    emailSketch,
    addressSketch,
  });

  const hashes = scoreResult.hashes;

  // ---- Insert RedemptionRecord ------------------------------------------
  const newRecord = await prisma.redemptionRecord.create({
    data: {
      shopId: shop.id,
      protectedOfferId,
      orderGid: oid,
      orderName: oname,
      codeUsed,
      customerGid: customerGid(order) ?? null,

      emailCiphertext: canonEmail ? encrypt(canonEmail, dek) : null,
      phoneCiphertext: canonPhone ? encrypt(canonPhone, dek) : null,
      addressCiphertext: addr ? encrypt(JSON.stringify(addr), dek) : null,
      billingAddressCiphertext: billingAddrForStorage
        ? encrypt(JSON.stringify(billingAddrForStorage), dek)
        : null,
      ipCiphertext: ip ? encrypt(ip, dek) : null,
      cardNameLast4Ciphertext: cardNameLast4
        ? encrypt(cardNameLast4, dek)
        : null,

      phoneHash: hashes["phone"] ?? null,
      emailCanonicalHash: hashes["email_canonical"] ?? null,
      addressFullHash: hashes["address_full"] ?? null,
      billingAddressFullHash: hashes["billing_address_full"] ?? null,
      ipHash24: hashes["ip_v4_24"] ?? hashes["ip_v6_48"] ?? null,
      cardNameLast4Hash: hashes["card_name_last4"] ?? null,

      emailMinhashSketch: emailSketch ? JSON.stringify(emailSketch) : null,
      addressMinhashSketch: addressSketch
        ? JSON.stringify(addressSketch)
        : null,
    },
  });

  // ---- Flag if needed ----------------------------------------------------
  if (scoreResult.decision !== "allow") {
    const riskLevel = scoreResult.decision === "block" ? "HIGH" : "MEDIUM";
    const facts = scoreResult.matchedSignals.map((sig) => ({
      description: `Promo Guard: matched ${sig} of a prior redemption`,
      sentiment: "NEGATIVE" as const,
    }));

    let riskAssessmentGid: string | null = null;
    try {
      const r = await orderRiskAssessmentCreate(adminClient.graphql, {
        orderId: oid,
        riskLevel,
        facts:
          facts.length > 0
            ? facts
            : [
                {
                  description: "Promo Guard flagged this order",
                  sentiment: "NEGATIVE",
                },
              ],
      });
      riskAssessmentGid = r.riskAssessmentId;
    } catch (err) {
      // Surface but don't crash — the FlaggedOrder row is the durable record.
      console.error(
        "[orders_paid] orderRiskAssessmentCreate failed",
        err instanceof Error ? err.message : err,
      );
    }

    let tagged = false;
    try {
      await tagsAdd(adminClient.graphql, oid, ["promo-guard-flagged"]);
      tagged = true;
    } catch (err) {
      console.error(
        "[orders_paid] tagsAdd failed",
        err instanceof Error ? err.message : err,
      );
    }

    await prisma.flaggedOrder.create({
      data: {
        shopId: shop.id,
        protectedOfferId,
        orderGid: oid,
        orderName: oname,
        customerGid: customerGid(order) ?? null,
        riskLevel,
        score: scoreResult.score,
        facts: JSON.stringify(scoreResult.matchedSignals),
        riskAssessmentGid,
        tagged,
      },
    });
  }

  // ---- Tag the customer as a known redeemer (shop-wide) -----------------
  // The Function reads `customer.hasAnyTag(["promo-guard-redeemed"])` to
  // short-circuit to HIGH for known redeemers without the shard read (see
  // docs/function-queries-spec.md §9). Best-effort: if the order had no
  // customer attached (guest) we skip.
  const custGid = customerGid(order);
  if (custGid) {
    try {
      await tagsAdd(adminClient.graphql, custGid, ["promo-guard-redeemed"]);
    } catch (err) {
      console.error(
        "[orders_paid] tagsAdd(customer) failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ---- Enqueue shard append ---------------------------------------------
  await enqueueJob({
    shopId: shop.id,
    type: "shard_append",
    payload: {
      shopDomain: shop.shopDomain,
      shopGid: args.shopGid,
      saltHex: shop.salt,
      defaultCountryCc: null,
      entry: {
        ts: Math.floor(newRecord.createdAt.getTime() / 1000),
        phone: hashes["phone"] ?? "",
        email: hashes["email_canonical"] ?? "",
        addr_full: hashes["address_full"] ?? "",
        addr_house: hashes["address_house"] ?? "",
        ip24: hashes["ip_v4_24"] ?? hashes["ip_v6_48"] ?? "",
        device: hashes["device"] ?? "",
        email_sketch: padSketch(emailSketch),
        addr_sketch: padSketch(addressSketch),
      },
    },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function padSketch(
  s: number[] | undefined,
): [number, number, number, number] {
  const a = s ?? [];
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
}

