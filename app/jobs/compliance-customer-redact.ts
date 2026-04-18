/**
 * See: docs/webhook-spec.md §7 (customers/redact worker)
 *      docs/function-queries-spec.md §9 (Plan C shop-wide shard)
 * Related: app/routes/webhooks.customers.redact.tsx,
 *          app/lib/shards.server.ts
 *
 * Null out all PII-adjacent columns on RedemptionRecord rows owned by the
 * redacted customer, rebuild the shop-wide shard metafield from the
 * remaining non-redacted rows, and remove the shop-wide
 * `promo-guard-redeemed` tag from the customer.
 *
 * We keep the RedemptionRecord rows for referential integrity with
 * FlaggedOrder; only the hashes + ciphertexts + customerGid are nulled.
 */
import type { RedemptionRecord } from "@prisma/client";

import prisma from "../db.server.js";
import { tagsRemove } from "../lib/admin-graphql.server.js";
import type { JobHandler } from "../lib/jobs.server.js";
import {
  mergeEntry,
  newShard,
  rebuildShard,
  type Shard,
  type ShardEntry,
} from "../lib/shards.server.js";
import { resolveShopGid } from "../lib/shop.server.js";
import { unauthenticated } from "../shopify.server.js";

export interface ComplianceCustomerRedactPayload {
  complianceRequestId: string;
}

function isPayload(x: unknown): x is ComplianceCustomerRedactPayload {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as { complianceRequestId?: unknown }).complianceRequestId ===
      "string"
  );
}

/**
 * Parse a sketch that was persisted as JSON into a `[u32,u32,u32,u32]`. The
 * storage is `JSON.stringify([n,n,n,n])`; returns `[0,0,0,0]` when the row
 * has no sketch or the JSON is malformed (safe zero is dropped by
 * `mergeEntry`).
 */
function parseSketch(
  raw: string | null,
): [number, number, number, number] {
  if (!raw) return [0, 0, 0, 0];
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((n) => typeof n === "number")
    ) {
      return parsed as [number, number, number, number];
    }
  } catch {
    // fall through
  }
  return [0, 0, 0, 0];
}

/**
 * Hydrate a `ShardEntry` from a stored RedemptionRecord row. Fields that
 * weren't captured at redemption time (or were nulled by a redact) come
 * through as empty — `mergeEntry` drops those so the shard stays clean.
 */
export function entryFromRecord(record: RedemptionRecord): ShardEntry {
  return {
    ts: Math.floor(record.createdAt.getTime() / 1000),
    phone: record.phoneHash ?? "",
    email: record.emailCanonicalHash ?? "",
    addr_full: record.addressFullHash ?? "",
    // RedemptionRecord doesn't persist addr_house today (only addr_full).
    // When it's added, plumb it through here.
    addr_house: "",
    ip24: record.ipHash24 ?? "",
    device: "",
    email_sketch: parseSketch(record.emailMinhashSketch),
    addr_sketch: parseSketch(record.addressMinhashSketch),
  };
}

export const complianceCustomerRedactHandler: JobHandler<unknown> = async (
  payload,
) => {
  if (!isPayload(payload)) {
    throw new Error(
      "compliance_customer_redact: missing complianceRequestId in payload",
    );
  }

  const cr = await prisma.complianceRequest.findUnique({
    where: { id: payload.complianceRequestId },
  });
  if (!cr) {
    // Row gone (shop cascaded away?). Nothing to do.
    return;
  }
  if (cr.status === "completed") {
    return;
  }

  const shop = await prisma.shop.findUnique({ where: { id: cr.shopId } });
  if (!shop) {
    await prisma.complianceRequest.update({
      where: { id: cr.id },
      data: {
        status: "failed",
        error: "shop not found",
        completedAt: new Date(),
      },
    });
    return;
  }

  const customerGid = cr.customerGid;
  if (!customerGid) {
    // Nothing identifies a customer — mark completed and move on.
    await prisma.complianceRequest.update({
      where: { id: cr.id },
      data: { status: "completed", completedAt: new Date() },
    });
    return;
  }

  // 1. Find all matching RedemptionRecord rows so we can tell whether there
  //    was anything to redact in the first place.
  const records: RedemptionRecord[] = await prisma.redemptionRecord.findMany({
    where: { shopId: shop.id, customerGid },
  });

  // 2. Null PII-ish columns on every matching row. We keep the row itself for
  //    FlaggedOrder referential integrity.
  if (records.length > 0) {
    await prisma.redemptionRecord.updateMany({
      where: { shopId: shop.id, customerGid },
      data: {
        customerGid: null,
        emailCiphertext: null,
        phoneCiphertext: null,
        addressCiphertext: null,
        ipCiphertext: null,
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    });
  }

  // 3. Rebuild the shop-wide shard from the rows that REMAIN after redact.
  //    (The redacted customer's rows are still in the table but with all
  //    hash/sketch columns nulled, so `entryFromRecord` yields empty fields
  //    that `mergeEntry` drops.)
  //    We also remove the shop-wide redeemer tag from the customer, if any.
  if (records.length === 0) {
    await prisma.complianceRequest.update({
      where: { id: cr.id },
      data: { status: "completed", completedAt: new Date(), error: null },
    });
    return;
  }

  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    const shopGid = await resolveShopGid(shop, admin);
    const creds = {
      shopDomain: shop.shopDomain,
      shopGid,
    };

    // Pull every RedemptionRecord for the shop (not just the redacted
    // customer) and rebuild the shard from the surviving hashes.
    const remaining: RedemptionRecord[] =
      await prisma.redemptionRecord.findMany({
        where: { shopId: shop.id },
      });

    let shard: Shard = newShard(shop.salt, null);
    for (const r of remaining) {
      shard = mergeEntry(shard, entryFromRecord(r));
    }
    await rebuildShard(admin.graphql, creds, shard);

    // Drop the shop-wide redeemer tag; the order-level `promo-guard-flagged`
    // tag lives on orders and is handled by shop/redact when the shop goes.
    await tagsRemove(admin.graphql, customerGid, ["promo-guard-redeemed"]);
  } catch (err) {
    // Surface Admin API failures as a job error so the queue retries us.
    await prisma.complianceRequest.update({
      where: { id: cr.id },
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  // 4. Mark done.
  await prisma.complianceRequest.update({
    where: { id: cr.id },
    data: { status: "completed", completedAt: new Date(), error: null },
  });
};
