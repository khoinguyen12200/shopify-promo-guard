/**
 * One-shot backfill: re-derive `RedemptionRecord.ipHash24` for rows that were
 * written before IPv6 support landed.
 *
 * Scope: only rows with `ipCiphertext IS NOT NULL` and `ipHash24 IS NULL`.
 * That's exactly the population the old `/^(\d+\.\d+\.\d+)\.\d+$/` regex
 * dropped on the floor. IPv4 rows that were correctly hashed are untouched.
 *
 * The IP ciphertext stays as-is; this only backfills the hash column so the
 * post-order scorer (scorePostOrder in app/lib/scoring/score.server.ts) can
 * match on it. Shard metafields remain unchanged — per docs/scoring-spec.md
 * §4.8 the Function never reads IP at checkout, so the shard omission has no
 * runtime effect. A subsequent salt rotation will regenerate shards.
 *
 * Usage:
 *   npx tsx scripts/backfill-ip-hashes.ts          # all shops
 *   npx tsx scripts/backfill-ip-hashes.ts --dry    # report only, no writes
 */

import "dotenv/config";

import prisma from "../app/db.server.js";
import { decrypt, loadKek, unwrapDek } from "../app/lib/crypto.server.js";
import { hashForLookup, hashToHex } from "../app/lib/hash.server.js";
import { ipPrefixKey } from "../app/lib/normalize/ip.server.js";

const DRY_RUN = process.argv.includes("--dry");

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function backfillShop(
  shop: { id: string; shopDomain: string; salt: string; encryptionKey: string },
  kek: Buffer,
): Promise<{ scanned: number; updated: number; skipped: number }> {
  const dek = unwrapDek(shop.encryptionKey, kek);
  const salt = hexBytes(shop.salt);

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const rows = await prisma.redemptionRecord.findMany({
      where: {
        shopId: shop.id,
        ipHash24: null,
        NOT: { ipCiphertext: null },
      },
      select: { id: true, ipCiphertext: true },
    });

    for (const row of rows) {
      scanned++;
      if (!row.ipCiphertext) continue;

      let ipPlain: string;
      try {
        ipPlain = decrypt(row.ipCiphertext, dek).toString("utf8");
      } catch {
        skipped++;
        continue;
      }

      const prefix = ipPrefixKey(ipPlain);
      if (!prefix) {
        skipped++;
        continue;
      }

      const hex = hashToHex(
        hashForLookup(prefix.tag, new TextEncoder().encode(prefix.key), salt),
      );

      if (!DRY_RUN) {
        await prisma.redemptionRecord.update({
          where: { id: row.id },
          data: { ipHash24: hex },
        });
      }
      updated++;
    }
  } finally {
    dek.fill(0);
  }

  return { scanned, updated, skipped };
}

async function main(): Promise<void> {
  const kek = loadKek();
  const shops = await prisma.shop.findMany({
    select: { id: true, shopDomain: true, salt: true, encryptionKey: true },
  });

  const tag = DRY_RUN ? "[dry-run]" : "[backfill]";
  console.log(`${tag} shops to scan: ${shops.length}`);

  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const shop of shops) {
    const { scanned, updated, skipped } = await backfillShop(shop, kek);
    totalScanned += scanned;
    totalUpdated += updated;
    totalSkipped += skipped;
    if (scanned > 0) {
      console.log(
        `${tag} ${shop.shopDomain}: scanned=${scanned} updated=${updated} skipped=${skipped}`,
      );
    }
  }

  console.log(
    `${tag} done. total scanned=${totalScanned} updated=${totalUpdated} skipped=${totalSkipped}`,
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
