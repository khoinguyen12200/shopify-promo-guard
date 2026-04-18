/**
 * See: docs/webhook-spec.md §5 (shard_append sub-job)
 *      docs/scoring-spec.md §5.2 (post-order scoring)
 *
 * Sub-job spawned by `handle-orders-paid` after a RedemptionRecord is
 * inserted. Reads the current shop-level shard metafield, appends the new
 * entry, evicts oldest until under the 10 KB cap, and writes back. The
 * advisory lock inside `appendEntry` serialises concurrent appends per
 * (shop, offer).
 */

import type { JobHandler } from "../lib/jobs.server.js";
import { appendEntry, type ShardEntry } from "../lib/shards.server.js";
import { unauthenticated } from "../shopify.server.js";

export interface ShardAppendPayload {
  shopDomain: string;
  shopGid: string;
  protectedOfferId: string;
  shopSalt?: string;
  entry: ShardEntry;
}

function isPayload(x: unknown): x is ShardAppendPayload {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.shopDomain === "string" &&
    typeof p.shopGid === "string" &&
    typeof p.protectedOfferId === "string" &&
    !!p.entry &&
    typeof p.entry === "object"
  );
}

export const handleShardAppend: JobHandler<unknown> = async (payload) => {
  if (!isPayload(payload)) {
    throw new Error("shard_append: malformed payload");
  }

  const { admin } = await unauthenticated.admin(payload.shopDomain);
  await appendEntry(
    admin.graphql,
    { shopDomain: payload.shopDomain, shopGid: payload.shopGid },
    payload.protectedOfferId,
    payload.entry,
    { shopSalt: payload.shopSalt ?? "" },
  );
};
