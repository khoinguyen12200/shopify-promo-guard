/**
 * See: docs/database-design.md § Encryption approach (per-shop salt + DEK)
 * Related: docs/normalization-spec.md §7 (salt handling)
 *          docs/webhook-spec.md §6 (reinstall within 48h keeps ledger intact)
 *
 * Install-lifecycle service. `ensureShop()` is the idempotent upsert called
 * during OAuth: first install generates a 32-byte hex salt + AES-256-GCM
 * wrapped DEK; subsequent calls refresh only the access token + scope, and
 * clear `uninstalledAt` if the shop was soft-deleted.
 */

import { randomBytes } from "node:crypto";

import type { Shop } from "@prisma/client";

import prisma from "../db.server.js";
import type { AdminGqlClient } from "./admin-graphql.server.js";
import { generateDek, loadKek, wrapDek } from "./crypto.server.js";

export interface EnsureShopParams {
  shopDomain: string;
  accessToken: string;
  scope: string;
}

/**
 * Idempotent shop upsert keyed on shopDomain.
 *
 * First insert:
 *   - Generates a 32-byte random salt (stored hex, length 64).
 *   - Generates a 32-byte DEK, wraps it under the App KEK, stores base64.
 *   - Sets installedAt = now(), uninstalledAt = null.
 *
 * Subsequent calls (existing row):
 *   - Preserves salt + encryptionKey (rotating them would invalidate every
 *     hash column + ciphertext — that's a separate explicit operation).
 *   - Updates accessToken + scope.
 *   - Clears uninstalledAt if set (reinstall within the 48h soft-delete
 *     window restores functionality with the ledger intact; see
 *     docs/webhook-spec.md §6).
 */
export async function ensureShop(params: EnsureShopParams): Promise<Shop> {
  const { shopDomain, accessToken, scope } = params;

  // Pre-compute create payload. We only ever need it on insert; upsert's
  // `create` branch is evaluated eagerly by Prisma regardless, so wrapping
  // the DEK here is fine — we use the in-memory plaintext for exactly as
  // long as this function's stack frame.
  const kek = loadKek();
  const dek = generateDek();
  try {
    const wrappedDek = wrapDek(dek, kek);
    const salt = randomBytes(32).toString("hex");

    return await prisma.shop.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        accessToken,
        scope,
        salt,
        encryptionKey: wrappedDek,
      },
      update: {
        accessToken,
        scope,
        uninstalledAt: null,
      },
    });
  } finally {
    dek.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Shopify shop GID lookup
// ---------------------------------------------------------------------------

const SHOP_ID_QUERY = /* GraphQL */ `
  query PromoGuardShopId {
    shop {
      id
    }
  }
`;

type ShopIdResponse = {
  status?: number;
  json: () => Promise<{ data?: { shop?: { id?: string } } }>;
};

/**
 * Resolve the canonical `gid://shopify/Shop/<id>` for a shop, caching it in
 * `Shop.shopifyShopId` on first lookup. The session's `id` is NOT the shop
 * GID (it's the session identifier), so every mutation that uses `ownerId`
 * (metafieldsSet, tagsAdd on shop) must go through this helper.
 */
export async function resolveShopGid(
  shop: Pick<Shop, "id" | "shopDomain" | "shopifyShopId">,
  adminClient: { graphql: AdminGqlClient },
): Promise<string> {
  if (shop.shopifyShopId && shop.shopifyShopId.startsWith("gid://shopify/Shop/")) {
    return shop.shopifyShopId;
  }
  const call = adminClient.graphql as unknown as (
    q: string,
  ) => Promise<ShopIdResponse>;
  const raw = await call(SHOP_ID_QUERY);
  const body = await raw.json();
  const gid = body.data?.shop?.id;
  if (!gid || !gid.startsWith("gid://shopify/Shop/")) {
    throw new Error(
      `resolveShopGid(${shop.shopDomain}): Admin API returned no shop.id`,
    );
  }
  await prisma.shop.update({
    where: { id: shop.id },
    data: { shopifyShopId: gid },
  });
  return gid;
}
