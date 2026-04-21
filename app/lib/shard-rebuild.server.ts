/**
 * Hydrate the shop-wide v2 shard from the Postgres ledger, then write it.
 *
 * Used whenever shard contents drift from what the DB says they should be:
 * - merchant activates / deactivates an offer (changes which offers'
 *   buckets belong in the shard at all)
 * - merchant flips an offer's mode (block ↔ watch — stamp the new mode on
 *   the existing bucket)
 * - GDPR `customers/redact` nulled some hashes (rebuild from survivors)
 *
 * Only `status = "active"` offers get a bucket. Inactive/archived offers'
 * data is excluded so the validator stops scoring against them.
 */

import prisma from "../db.server.js";

import type { AdminGqlClient } from "./admin-graphql.server.js";
import {
  mergeEntry,
  newShard,
  rebuildShard,
  type OfferMode,
  type Shard,
} from "./shards.server.js";

function parseSketch(raw: string | null): [number, number, number, number] {
  if (!raw) return [0, 0, 0, 0];
  try {
    const p = JSON.parse(raw);
    if (
      Array.isArray(p) &&
      p.length === 4 &&
      p.every((n: unknown) => typeof n === "number")
    ) {
      return p as [number, number, number, number];
    }
  } catch {
    // ignore
  }
  return [0, 0, 0, 0];
}

export interface RebuildArgs {
  shopId: string;
  shopDomain: string;
  shopGid: string;
  saltHex: string;
  defaultCountryCc?: string | null;
}

/**
 * Pull every active offer + its redemption records out of Postgres and write
 * a freshly-assembled v2 shard. Inactive/archived offers are not included —
 * the validator will see no bucket for them and stop blocking on their data.
 */
export async function rebuildShardForShop(
  client: AdminGqlClient,
  args: RebuildArgs,
): Promise<{ shard: Shard; bytes: number }> {
  const offers = await prisma.protectedOffer.findMany({
    where: { shopId: args.shopId, status: "active", archivedAt: null },
    select: { id: true, mode: true },
  });

  const modeByOffer = new Map<string, OfferMode>();
  for (const o of offers) {
    modeByOffer.set(o.id, o.mode === "watch" ? "watch" : "block");
  }
  const activeIds = Array.from(modeByOffer.keys());

  let shard: Shard = newShard(args.saltHex, args.defaultCountryCc ?? null);

  if (activeIds.length > 0) {
    const records = await prisma.redemptionRecord.findMany({
      where: { shopId: args.shopId, protectedOfferId: { in: activeIds } },
    });
    for (const r of records) {
      const mode = modeByOffer.get(r.protectedOfferId);
      if (!mode) continue; // offer became inactive between queries
      shard = mergeEntry(
        shard,
        {
          protectedOfferId: r.protectedOfferId,
          ts: Math.floor(r.createdAt.getTime() / 1000),
          phone: r.phoneHash ?? "",
          email: r.emailCanonicalHash ?? "",
          addr_full: r.addressFullHash ?? "",
          addr_house: "",
          ip24: r.ipHash24 ?? "",
          device: "",
          email_sketch: parseSketch(r.emailMinhashSketch),
          addr_sketch: parseSketch(r.addressMinhashSketch),
        },
        mode,
      );
    }
  }

  return rebuildShard(client, { shopDomain: args.shopDomain, shopGid: args.shopGid }, shard);
}
