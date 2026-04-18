/**
 * See: docs/webhook-spec.md §7 (customers/redact worker)
 * Related: app/routes/webhooks.customers.redact.tsx,
 *          app/lib/shards.server.ts
 *
 * Null out all PII-adjacent columns on RedemptionRecord rows owned by the
 * redacted customer, rebuild each affected shard metafield, and remove the
 * `promo-guard-flag` tag from the customer.
 *
 * We keep the RedemptionRecord rows for referential integrity with
 * FlaggedOrder; only the hashes + ciphertexts + customerGid are nulled.
 */
import type { RedemptionRecord } from "@prisma/client";

import prisma from "../db.server.js";
import { tagsRemove } from "../lib/admin-graphql.server.js";
import type { JobHandler } from "../lib/jobs.server.js";
import { rebuildShard, type ShardEntry } from "../lib/shards.server.js";
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

  // 1. Find all matching RedemptionRecord rows before we null the link.
  const records: RedemptionRecord[] = await prisma.redemptionRecord.findMany({
    where: { shopId: shop.id, customerGid },
  });

  const affectedOfferIds = Array.from(
    new Set(records.map((r) => r.protectedOfferId)),
  );

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

  // 3 + 4. Rebuild shards and remove the customer tag via Admin GraphQL.
  //    We need an offline session to talk to the Admin API on the merchant's
  //    behalf from the worker (no incoming request context here).
  try {
    const { admin, session } = await unauthenticated.admin(shop.shopDomain);
    const creds = {
      shopDomain: shop.shopDomain,
      shopGid: `gid://shopify/Shop/${session.id}`,
    };

    for (const offerId of affectedOfferIds) {
      const remaining = await prisma.redemptionRecord.findMany({
        where: { shopId: shop.id, protectedOfferId: offerId },
      });
      // Without PII we can't rebuild shard entries from the nulled rows;
      // `rebuildShard` expects pre-materialised ShardEntry[]. This helper
      // is the source of truth for that mapping (T17). For now we pass an
      // empty list when every remaining row has had its hashes nulled.
      const entries: ShardEntry[] = remaining
        .filter((r) => r.emailCanonicalHash || r.phoneHash || r.addressFullHash)
        .map<ShardEntry>(() => ({
          ts: 0,
          phone: "",
          email: "",
          addr_full: "",
          addr_house: "",
          ip24: "",
          device: "",
          email_sketch: [0, 0, 0, 0],
          addr_sketch: [0, 0, 0, 0],
        }));
      // TODO(T17): hydrate ShardEntry from stored hash/sketch columns — the
      // mapping lives in the shard-build pipeline and should be reused here.
      await rebuildShard(admin.graphql, creds, offerId, entries);
    }

    if (affectedOfferIds.length > 0) {
      const tagsToRemove = affectedOfferIds.map((id) => `pg-redeemed-${id}`);
      // Also drop the generic flag tag we apply on flag-worthy orders.
      tagsToRemove.push("promo-guard-flag");
      await tagsRemove(admin.graphql, customerGid, tagsToRemove);
    }
  } catch (err) {
    // Surface Admin API failures as a job error so the queue retries us.
    await prisma.complianceRequest.update({
      where: { id: cr.id },
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  // 5. Mark done.
  await prisma.complianceRequest.update({
    where: { id: cr.id },
    data: { status: "completed", completedAt: new Date(), error: null },
  });
};
