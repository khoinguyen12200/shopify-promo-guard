/**
 * See: docs/admin-ui-spec.md §6 (Offer detail — Activate/Deactivate, mode)
 *
 * Block-only enforcement (silent_strip mode was removed). One discount code
 * per offer. Status drives the validator's per-offer bucket inclusion:
 * "active" → bucket lives in the shard; "inactive" / "archived" → bucket is
 * removed and the validator stops scoring against this offer.
 */

import prisma from "../db.server.js";

import type { AdminGqlClient } from "./admin-graphql.server.js";
import { rebuildShardForShop } from "./shard-rebuild.server.js";

// Checkout-time Validation Function is DISABLED. We're migrating enforcement
// to a Discount Function (`enteredDiscountCodesReject`) so regular full-price
// checkouts aren't blocked — see docs/admin-ui-spec.md. Until that lands,
// status/mode flips and delete only rebuild the shard; they DON'T touch the
// Shopify-level validation state.

export type OfferStatus = "active" | "inactive";
export type OfferMode = "block" | "watch";

interface ShopRefs {
  id: string;
  shopDomain: string;
  shopGid: string;
  saltHex: string;
}

// -- Status transitions -----------------------------------------------------

/**
 * Flip a protected offer's status. Rebuilds the shop-wide shard so the
 * validator immediately sees the change. If the toggle leaves the shop with
 * zero active offers, the checkout validation is disabled at the Shopify
 * level too — no point running it for a shop that's not protecting anything.
 */
export async function setOfferStatus(args: {
  client: AdminGqlClient;
  shop: ShopRefs;
  offerId: string;
  status: OfferStatus;
}): Promise<{ status: OfferStatus }> {
  const updated = await prisma.protectedOffer.updateMany({
    where: { id: args.offerId, shopId: args.shop.id, archivedAt: null },
    data: { status: args.status },
  });
  if (updated.count === 0) {
    throw new Error("setOfferStatus: offer not found or archived");
  }

  // Rebuild the shard so the validator sees the new active-offer set
  // immediately. Inactive offers' buckets drop out, active ones stay.
  await rebuildShardForShop(args.client, {
    shopId: args.shop.id,
    shopDomain: args.shop.shopDomain,
    shopGid: args.shop.shopGid,
    saltHex: args.shop.saltHex,
  });

  return { status: args.status };
}

// -- Mode change ------------------------------------------------------------

export async function setOfferMode(args: {
  client: AdminGqlClient;
  shop: ShopRefs;
  offerId: string;
  mode: OfferMode;
}): Promise<{ mode: OfferMode }> {
  const updated = await prisma.protectedOffer.updateMany({
    where: { id: args.offerId, shopId: args.shop.id, archivedAt: null },
    data: { mode: args.mode },
  });
  if (updated.count === 0) {
    throw new Error("setOfferMode: offer not found or archived");
  }

  // Rebuild so the bucket's mode flag is updated in the shard. Without this
  // the validator would keep using the old mode until the next redemption
  // happens to repopulate the bucket.
  await rebuildShardForShop(args.client, {
    shopId: args.shop.id,
    shopDomain: args.shop.shopDomain,
    shopGid: args.shop.shopGid,
    saltHex: args.shop.saltHex,
  });

  return { mode: args.mode };
}

// -- Field updates ----------------------------------------------------------

export interface UpdateOfferFieldsInput {
  offerId: string;
  shopId: string;
  name?: string;
}

/**
 * Update the editable fields of a protected offer. Code, status, and mode
 * are NOT mutable through this path — they have dedicated lifecycle helpers
 * because they require side effects (shard rebuild, validation toggle).
 */
export async function updateOfferFields(
  args: UpdateOfferFieldsInput,
): Promise<{ updated: boolean }> {
  const data: { name?: string } = {};
  if (typeof args.name === "string") data.name = args.name.trim();
  if (Object.keys(data).length === 0) return { updated: false };

  const result = await prisma.protectedOffer.updateMany({
    where: {
      id: args.offerId,
      shopId: args.shopId,
      archivedAt: null,
    },
    data,
  });
  if (result.count === 0) {
    throw new Error("updateOfferFields: offer not found or archived");
  }
  return { updated: true };
}

// -- Delete -----------------------------------------------------------------

export interface DeleteOfferInput {
  client: AdminGqlClient;
  shop: ShopRefs;
  offerId: string;
}

/**
 * Soft-delete a protected offer (`archivedAt = now`). Child RedemptionRecord
 * and FlaggedOrder rows are preserved so history and audit trails survive.
 *
 * The merchant's Shopify discount is untouched — we never owned it. The
 * shard is rebuilt without the deleted offer's bucket, and if no active
 * offers remain, the Shopify checkout validation is disabled.
 */
export async function deleteOffer(input: DeleteOfferInput): Promise<void> {
  const updated = await prisma.protectedOffer.updateMany({
    where: {
      id: input.offerId,
      shopId: input.shop.id,
      archivedAt: null,
    },
    data: { archivedAt: new Date(), status: "archived" },
  });
  if (updated.count === 0) {
    throw new Error("deleteOffer: offer not found or already archived");
  }

  await rebuildShardForShop(input.client, {
    shopId: input.shop.id,
    shopDomain: input.shop.shopDomain,
    shopGid: input.shop.shopGid,
    saltHex: input.shop.saltHex,
  });
}
