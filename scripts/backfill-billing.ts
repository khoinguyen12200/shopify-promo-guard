/**
 * One-shot backfill for the `billingAddress*` columns on RedemptionRecord.
 * Rows written before the billing-address second-slot landed captured
 * shipping-or-billing into the single `addressCiphertext` — this script
 * re-queries each order via Admin GraphQL, and if billing differs from
 * shipping, encrypts + hashes the billing side into the new columns.
 *
 * Rows where shipping == billing stay untouched (nothing meaningful to
 * backfill).
 *
 * Usage:
 *   npx tsx scripts/backfill-billing.ts          # all shops
 *   npx tsx scripts/backfill-billing.ts --dry    # report only
 */

import "dotenv/config";

import prisma from "../app/db.server.js";
import { encrypt, loadKek, unwrapDek } from "../app/lib/crypto.server.js";
import { hashForLookup, hashToHex } from "../app/lib/hash.server.js";
import { fullKey } from "../app/lib/normalize/address.server.js";
import { unauthenticated } from "../app/shopify.server.js";

const DRY_RUN = process.argv.includes("--dry");

const ORDER_BACKFILL_QUERY = /* GraphQL */ `
  query OrderBillingBackfill($id: ID!) {
    order(id: $id) {
      shippingAddress {
        address1
        address2
        zip
        countryCodeV2
      }
      billingAddress {
        address1
        address2
        zip
        countryCodeV2
      }
    }
  }
`;

interface OrderAddress {
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
}

interface OrderBackfillData {
  order: {
    shippingAddress: OrderAddress | null;
    billingAddress: OrderAddress | null;
  } | null;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toAddrFullKey(addr: OrderAddress | null): string | null {
  if (!addr) return null;
  return fullKey({
    line1: addr.address1 ?? "",
    line2: addr.address2 ?? "",
    zip: addr.zip ?? "",
    countryCode: addr.countryCodeV2 ?? "",
  });
}

async function fetchOrder(
  graphql: (
    q: string,
    opts: { variables: Record<string, unknown> },
  ) => Promise<unknown>,
  orderGid: string,
): Promise<OrderBackfillData["order"]> {
  const raw = await graphql(ORDER_BACKFILL_QUERY, {
    variables: { id: orderGid },
  });
  const body =
    raw && typeof (raw as { json?: unknown }).json === "function"
      ? ((await (raw as { json: () => Promise<unknown> }).json()) as {
          data?: OrderBackfillData;
          errors?: Array<{ message: string }>;
        })
      : (raw as { data?: OrderBackfillData });
  return body?.data?.order ?? null;
}

async function backfillShop(shop: {
  id: string;
  shopDomain: string;
  salt: string;
  encryptionKey: string;
}): Promise<{ scanned: number; billing: number; skipped: number }> {
  const kek = loadKek();
  const dek = unwrapDek(shop.encryptionKey, kek);
  const salt = hexBytes(shop.salt);

  let scanned = 0;
  let billing = 0;
  let skipped = 0;

  try {
    const rows = await prisma.redemptionRecord.findMany({
      where: {
        shopId: shop.id,
        billingAddressCiphertext: null,
      },
      select: {
        id: true,
        orderGid: true,
        billingAddressCiphertext: true,
      },
    });

    if (rows.length === 0) return { scanned, billing, skipped };

    let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
    try {
      const ctx = await unauthenticated.admin(shop.shopDomain);
      admin = ctx.admin;
    } catch (err) {
      console.error(
        `[backfill] skipping ${shop.shopDomain}: cannot obtain admin client (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return { scanned, billing, skipped: rows.length };
    }

    for (const row of rows) {
      scanned++;
      let order: OrderBackfillData["order"];
      try {
        order = await fetchOrder(admin.graphql, row.orderGid);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : err && typeof err === "object" && "status" in err
              ? `HTTP ${(err as { status: number }).status}`
              : String(err);
        console.error(`[backfill] fetch failed for ${row.orderGid}: ${msg}`);
        skipped++;
        continue;
      }
      if (!order) {
        skipped++;
        continue;
      }

      const shipKey = toAddrFullKey(order.shippingAddress);
      const billKey = toAddrFullKey(order.billingAddress);
      const billingDiffers =
        billKey != null && shipKey != null && billKey !== shipKey;
      if (!billingDiffers) continue;

      const hBill = hashToHex(
        hashForLookup("addr_full", new TextEncoder().encode(billKey), salt),
      );

      if (!DRY_RUN) {
        await prisma.redemptionRecord.update({
          where: { id: row.id },
          data: {
            billingAddressCiphertext: encrypt(
              JSON.stringify(order.billingAddress),
              dek,
            ),
            billingAddressFullHash: hBill,
          },
        });
      }
      billing++;
    }
  } finally {
    dek.fill(0);
  }

  return { scanned, billing, skipped };
}

async function main(): Promise<void> {
  const tag = DRY_RUN ? "[dry-run]" : "[backfill]";
  const shops = await prisma.shop.findMany({
    select: { id: true, shopDomain: true, salt: true, encryptionKey: true },
  });
  console.log(`${tag} shops to scan: ${shops.length}`);

  let scanned = 0;
  let billing = 0;
  let skipped = 0;

  for (const shop of shops) {
    const r = await backfillShop(shop);
    scanned += r.scanned;
    billing += r.billing;
    skipped += r.skipped;
    if (r.scanned > 0) {
      console.log(
        `${tag} ${shop.shopDomain}: scanned=${r.scanned} billing=${r.billing} skipped=${r.skipped}`,
      );
    }
  }

  console.log(
    `${tag} done. total scanned=${scanned} billing=${billing} skipped=${skipped}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill] fatal", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
