/**
 * See: docs/webhook-spec.md §5 (shard_append sub-job)
 *      docs/scoring-spec.md §5.2 (post-order scoring)
 *      docs/function-queries-spec.md §9 (Plan C shop-wide shard)
 *
 * Sub-job spawned by `handle-orders-paid` after a RedemptionRecord is
 * inserted. Reads the current shop-wide shard metafield, merges the new
 * entry, evicts oldest until under the 10 KB cap, and writes back. The
 * advisory lock inside `appendEntry` serialises concurrent appends per shop.
 */

import type { JobHandler } from "../lib/jobs.server.js";
import {
  appendEntry,
  type OfferMode,
  type ShardEntry,
} from "../lib/shards.server.js";
import { unauthenticated } from "../shopify.server.js";

export interface ShardAppendPayload {
  shopDomain: string;
  shopGid: string;
  /** Shop salt encoded as hex; embedded into the shard for the Function. */
  saltHex?: string;
  /** Default country code for E.164 normalization inside the Function. */
  defaultCountryCc?: string | null;
  /** Mode to stamp on the offer's bucket if it doesn't exist yet. */
  bucketMode?: OfferMode;
  entry: ShardEntry;
}

function isPayload(x: unknown): x is ShardAppendPayload {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.shopDomain === "string" &&
    typeof p.shopGid === "string" &&
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
    payload.entry,
    {
      saltHex: payload.saltHex ?? "",
      defaultCountryCc: payload.defaultCountryCc ?? null,
      bucketMode: payload.bucketMode ?? "block",
    },
  );
};
