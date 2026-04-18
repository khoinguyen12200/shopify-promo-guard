/**
 * See: docs/webhook-spec.md §7 (shop/redact)
 * Related: docs/database-design.md (cascade rules)
 *
 * Approach: rely entirely on `onDelete: Cascade` from the `Shop` row.
 * Every shop-owned table (`ProtectedOffer` → `ProtectedCode`,
 * `RedemptionRecord`, `FlaggedOrder`, `ShardState`; `Job`, `WebhookEvent`,
 * `AuditLog`, `ComplianceRequest`) cascades from `Shop.id`. We:
 *
 *   1. Mark the `ComplianceRequest` row as `completed` (so it has the
 *      audit-trail timestamp BEFORE it gets cascade-deleted).
 *   2. Delete the per-shop Shopify `Session` rows by domain (Session is
 *      keyed on `shop`, not our `shopId`, so it isn't on the cascade graph).
 *   3. Delete the `Shop` row → cascades to every other table, including the
 *      `ComplianceRequest` we just marked completed. Shopify's compliance
 *      audit only requires that we returned 200 to the webhook and that no
 *      shop data remains in our systems; we don't need to retain the row.
 *
 * Idempotent: if the Shop row is already gone (re-delivery after success),
 * the handler exits cleanly.
 */

import prisma from "../db.server.js";
import type { JobHandler } from "../lib/jobs.server.js";

export interface ComplianceShopRedactPayload {
  complianceRequestId: string;
  shopDomain: string;
}

export const handleComplianceShopRedact: JobHandler<
  ComplianceShopRedactPayload
> = async (payload, ctx) => {
  if (!payload?.complianceRequestId || !payload?.shopDomain) {
    throw new Error(
      "handleComplianceShopRedact: missing complianceRequestId or shopDomain in payload",
    );
  }

  const shop = await prisma.shop.findUnique({ where: { id: ctx.shopId } });
  if (!shop) {
    // Already purged by an earlier delivery — nothing to do.
    return;
  }

  // 1. Stamp completion BEFORE the row vanishes via cascade.
  await prisma.complianceRequest.update({
    where: { id: payload.complianceRequestId },
    data: { status: "completed", completedAt: new Date() },
  });

  // 2. Drop Shopify SDK sessions (not on the cascade graph — keyed by `shop`).
  await prisma.session.deleteMany({ where: { shop: payload.shopDomain } });

  // 3. Cascade-delete everything else owned by this shop.
  await prisma.shop.delete({ where: { id: ctx.shopId } });
};
