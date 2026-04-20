/**
 * One-shot backfill for two post-IPv6-fix signals:
 *
 *   1. `billingAddress*` columns (new second address slot — classic gap
 *      where we hashed shipping-or-billing but not both)
 *   2. `cardNameLast4*` columns (new signal, requires Admin GraphQL to fetch
 *      the cardholder name which isn't on the webhook payload)
 *
 * For each RedemptionRecord missing either column set, we re-query the order
 * by GID via Admin GraphQL, extract the fields, and write them in place. The
 * primary `addressCiphertext` / `addressFullHash` are left alone — we only
 * fill in the NEW columns.
 *
 * Usage:
 *   npx tsx scripts/backfill-billing-and-card.ts          # all shops
 *   npx tsx scripts/backfill-billing-and-card.ts --dry    # report only
 */

import "dotenv/config";

import prisma from "../app/db.server.js";
import { encrypt, loadKek, unwrapDek } from "../app/lib/crypto.server.js";
import { hashForLookup, hashToHex } from "../app/lib/hash.server.js";
import { fullKey } from "../app/lib/normalize/address.server.js";
import { normalizeCardNameLast4 } from "../app/lib/normalize/card.server.js";
import { unauthenticated } from "../app/shopify.server.js";

const DRY_RUN = process.argv.includes("--dry");

const ORDER_BACKFILL_QUERY = /* GraphQL */ `
  query OrderBackfill($id: ID!) {
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

interface OrderAddress {
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
}

interface CardTxn {
  kind?: string | null;
  status?: string | null;
  paymentDetails?: { name?: string | null; number?: string | null } | null;
}

interface OrderBackfillData {
  order: {
    shippingAddress: OrderAddress | null;
    billingAddress: OrderAddress | null;
    transactions: CardTxn[] | null;
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

function pickCardNameLast4(txns: CardTxn[] | null): string | null {
  for (const t of txns ?? []) {
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
}): Promise<{ scanned: number; billing: number; card: number; skipped: number }> {
  const kek = loadKek();
  const dek = unwrapDek(shop.encryptionKey, kek);
  const salt = hexBytes(shop.salt);

  let scanned = 0;
  let billing = 0;
  let card = 0;
  let skipped = 0;

  try {
    const rows = await prisma.redemptionRecord.findMany({
      where: {
        shopId: shop.id,
        OR: [
          { billingAddressCiphertext: null },
          { cardNameLast4Ciphertext: null },
        ],
      },
      select: {
        id: true,
        orderGid: true,
        addressFullHash: true,
        billingAddressCiphertext: true,
        cardNameLast4Ciphertext: true,
      },
    });

    if (rows.length === 0) return { scanned, billing, card, skipped };

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
      return { scanned, billing, card, skipped: scanned + rows.length };
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

      const data: Record<string, string | null> = {};

      if (!row.billingAddressCiphertext && billingDiffers) {
        const hBill = hashToHex(
          hashForLookup(
            "addr_full",
            new TextEncoder().encode(billKey),
            salt,
          ),
        );
        data.billingAddressCiphertext = encrypt(
          JSON.stringify(order.billingAddress),
          dek,
        );
        data.billingAddressFullHash = hBill;
        billing++;
      }

      if (!row.cardNameLast4Ciphertext) {
        const cardKey = pickCardNameLast4(order.transactions);
        if (cardKey) {
          const hCard = hashToHex(
            hashForLookup(
              "card_name_last4",
              new TextEncoder().encode(cardKey),
              salt,
            ),
          );
          data.cardNameLast4Ciphertext = encrypt(cardKey, dek);
          data.cardNameLast4Hash = hCard;
          card++;
        }
      }

      if (Object.keys(data).length > 0 && !DRY_RUN) {
        await prisma.redemptionRecord.update({
          where: { id: row.id },
          data,
        });
      }
    }
  } finally {
    dek.fill(0);
  }

  return { scanned, billing, card, skipped };
}

async function main(): Promise<void> {
  const tag = DRY_RUN ? "[dry-run]" : "[backfill]";
  const shops = await prisma.shop.findMany({
    select: { id: true, shopDomain: true, salt: true, encryptionKey: true },
  });
  console.log(`${tag} shops to scan: ${shops.length}`);

  let scanned = 0;
  let billing = 0;
  let card = 0;
  let skipped = 0;

  for (const shop of shops) {
    const r = await backfillShop(shop);
    scanned += r.scanned;
    billing += r.billing;
    card += r.card;
    skipped += r.skipped;
    if (r.scanned > 0) {
      console.log(
        `${tag} ${shop.shopDomain}: scanned=${r.scanned} billing=${r.billing} card=${r.card} skipped=${r.skipped}`,
      );
    }
  }

  console.log(
    `${tag} done. total scanned=${scanned} billing=${billing} card=${card} skipped=${skipped}`,
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
