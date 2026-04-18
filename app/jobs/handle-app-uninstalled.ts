/**
 * See: docs/webhook-spec.md §6 (app/uninstalled handler)
 * Related: docs/webhook-spec.md §8 (job retry semantics)
 *
 * Soft-delete on uninstall:
 *   1. Stamp Shop.uninstalledAt = now (preserved for the 48h reinstall grace).
 *   2. Revoke offline tokens by deleting Session rows for the shop domain.
 *   3. Cancel pending Jobs so the worker stops doing work for a shop that
 *      just removed our access token.
 *
 * We deliberately do NOT delete shop data here — `shop/redact` is the
 * authoritative deletion trigger and fires 48 hours later.
 */

import prisma from "../db.server.js";
import type { JobHandler } from "../lib/jobs.server.js";

export interface AppUninstalledPayload {
  shopDomain: string;
}

export const handleAppUninstalled: JobHandler<AppUninstalledPayload> = async (
  payload,
  ctx,
) => {
  const shopDomain = payload?.shopDomain;
  if (!shopDomain) {
    throw new Error("handleAppUninstalled: missing shopDomain in payload");
  }

  await prisma.$transaction([
    prisma.shop.update({
      where: { id: ctx.shopId },
      data: { uninstalledAt: new Date() },
    }),
    prisma.session.deleteMany({ where: { shop: shopDomain } }),
    prisma.job.updateMany({
      where: { shopId: ctx.shopId, status: "pending" },
      data: { status: "cancelled" },
    }),
  ]);
};
