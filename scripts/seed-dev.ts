/**
 * Idempotent dev seed — ensures a fake Shop row exists at
 * `dev-shop.myshopify.com` so local dev flows (UI routes, worker, Function
 * tests) always have a shop to hang data off without running OAuth.
 *
 * Run via `make seed` or directly:
 *   DATABASE_URL=postgresql://promo:promo@localhost:5434/promo_guard \
 *     npx tsx scripts/seed-dev.ts
 */

import "dotenv/config";

import prisma from "../app/db.server.js";
import { ensureShop } from "../app/lib/shop.server.js";

const DEV_SHOP_DOMAIN = "dev-shop.myshopify.com";

async function main(): Promise<void> {
  const shop = await ensureShop({
    shopDomain: DEV_SHOP_DOMAIN,
    accessToken: "dev-token",
    scope: "write_products",
  });
  // eslint-disable-next-line no-console
  console.log(`seeded ${shop.shopDomain} (id=${shop.id})`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("seed-dev failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
