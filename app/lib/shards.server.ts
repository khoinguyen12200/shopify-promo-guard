/**
 * See: docs/webhook-spec.md §5 (shard_append sub-job),
 *      docs/function-queries-spec.md §2 (shard format)
 *
 * Per-offer shard metafield: serialize/parse the JSON value, append a new
 * entry, evict oldest entries until under 10 KB, and rebuild the whole
 * shard from scratch (used by redaction). Concurrent appends for the same
 * offer are serialized via a Postgres advisory lock keyed by a stable hash
 * of `shopDomain:offerId`.
 *
 * The Admin GraphQL helpers in `./admin-graphql.server.ts` accept an
 * `AdminGqlClient` (shape: `(query, { variables }) => ResponseLike`); we
 * mirror that pattern so callers always pass an injected client from
 * `authenticate.webhook` / `authenticate.admin`.
 */
import { createHash } from "node:crypto";

import prisma from "../db.server.js";

import {
  type AdminGqlClient,
  metafieldsSet,
} from "./admin-graphql.server.js";

// -- Constants --------------------------------------------------------------

export const SHARD_VERSION = 1 as const;
export const SHARD_NAMESPACE = "promo_guard" as const;
export const DEFAULT_MAX_SIZE_BYTES = 10_240;

export function shardKey(protectedOfferId: string): string {
  return `shard_v1_${protectedOfferId}`;
}

// -- Types ------------------------------------------------------------------

export interface ShardEntry {
  /** unix seconds */
  ts: number;
  /** 8-char hex u32, or "" */
  phone: string;
  /** fnv1a hex */
  email: string;
  addr_full: string;
  addr_house: string;
  ip24: string;
  device: string;
  /** 4 u32s */
  email_sketch: [number, number, number, number];
  addr_sketch: [number, number, number, number];
}

export interface Shard {
  v: typeof SHARD_VERSION;
  shop_salt: string;
  entries: ShardEntry[];
}

interface ShopCreds {
  shopDomain: string;
  /** GID of the Shop owner for the metafield (e.g. "gid://shopify/Shop/123") */
  shopGid: string;
}

// -- Serialize / parse ------------------------------------------------------

export function serializeShard(
  entries: ShardEntry[],
  shopSalt = "",
): string {
  const shard: Shard = {
    v: SHARD_VERSION,
    shop_salt: shopSalt,
    entries,
  };
  return JSON.stringify(shard);
}

/**
 * Parse a shard JSON string. Tolerates null and corrupt payloads — both
 * yield an empty entry list so callers can recover gracefully.
 */
export function parseShard(raw: string | null | undefined): ShardEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const maybeEntries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(maybeEntries)) return [];
  // Best-effort filter: keep only entries that look structurally sane.
  return maybeEntries.filter(
    (e): e is ShardEntry =>
      !!e && typeof e === "object" && typeof (e as ShardEntry).ts === "number",
  );
}

// -- Eviction ---------------------------------------------------------------

/**
 * Drop oldest entries (smallest `ts` first) until the serialized shard is
 * within `maxSizeBytes`. Returns a new array; does not mutate the input.
 */
export function evictOldest(
  entries: ShardEntry[],
  maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
  shopSalt = "",
): ShardEntry[] {
  // Sort newest-first so we can pop from the tail (oldest).
  const sorted = [...entries].sort((a, b) => b.ts - a.ts);
  while (
    sorted.length > 0 &&
    Buffer.byteLength(serializeShard(sorted, shopSalt), "utf8") > maxSizeBytes
  ) {
    sorted.pop();
  }
  return sorted;
}

// -- Read helper ------------------------------------------------------------

const GET_SHOP_METAFIELD = /* GraphQL */ `
  query GetShopMetafield($namespace: String!, $key: String!) {
    shop {
      metafield(namespace: $namespace, key: $key) {
        value
      }
    }
  }
`;

type ShopMetafieldQuery = {
  shop: { metafield: { value: string | null } | null };
};

type ResponseLike = {
  status?: number;
  json: () => Promise<unknown>;
};

function isResponseLike(x: unknown): x is ResponseLike {
  return !!x && typeof (x as ResponseLike).json === "function";
}

export async function getShopMetafield(
  client: AdminGqlClient,
  namespace: string,
  key: string,
): Promise<string | null> {
  const call = client as unknown as (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<ResponseLike>;
  const raw = await call(GET_SHOP_METAFIELD, {
    variables: { namespace, key },
  });
  let body: { data?: ShopMetafieldQuery; errors?: Array<{ message: string }> };
  if (isResponseLike(raw)) {
    body = (await raw.json()) as typeof body;
  } else {
    body = raw as unknown as typeof body;
  }
  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `getShopMetafield(${namespace}/${key}) errored: ${body.errors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
  return body.data?.shop?.metafield?.value ?? null;
}

// -- Advisory-lock key ------------------------------------------------------

/**
 * Map a `shopDomain:offerId` pair to a signed bigint suitable for
 * `pg_advisory_xact_lock`. We take the first 8 bytes of SHA-256 and
 * reinterpret as a signed 64-bit integer (Postgres advisory-lock arg type).
 */
export function advisoryLockKey(
  shopDomain: string,
  protectedOfferId: string,
): bigint {
  const digest = createHash("sha256")
    .update(`${shopDomain}:${protectedOfferId}`)
    .digest();
  // Read as signed BE 64-bit.
  const u = digest.readBigUInt64BE(0);
  // Convert unsigned → signed two's complement.
  return u >= 1n << 63n ? u - (1n << 64n) : u;
}

// -- Append / rebuild -------------------------------------------------------

export interface AppendOptions {
  /** Override `Date.now()` for tests. */
  nowMs?: number;
  /** Override the 10 KB cap (useful in tests). */
  maxSizeBytes?: number;
  /** Optional shop salt to embed in the serialized shard. */
  shopSalt?: string;
}

/**
 * Read the current shard, append `entry`, evict oldest until under cap,
 * and write back. Wrapped in a Postgres transaction holding an advisory
 * lock so concurrent appends for the same offer don't trample each other.
 */
export async function appendEntry(
  client: AdminGqlClient,
  creds: ShopCreds,
  protectedOfferId: string,
  entry: ShardEntry,
  opts: AppendOptions = {},
): Promise<{ entries: ShardEntry[]; bytes: number }> {
  const maxSize = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const shopSalt = opts.shopSalt ?? "";
  const key = shardKey(protectedOfferId);
  const lockKey = advisoryLockKey(creds.shopDomain, protectedOfferId);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    const raw = await getShopMetafield(client, SHARD_NAMESPACE, key);
    const existing = parseShard(raw);

    const stamped: ShardEntry = {
      ...entry,
      ts: entry.ts || Math.floor((opts.nowMs ?? Date.now()) / 1000),
    };
    const merged = evictOldest([...existing, stamped], maxSize, shopSalt);
    const value = serializeShard(merged, shopSalt);

    await metafieldsSet(client, [
      {
        ownerId: creds.shopGid,
        namespace: SHARD_NAMESPACE,
        key,
        type: "json",
        value,
      },
    ]);

    return { entries: merged, bytes: Buffer.byteLength(value, "utf8") };
  });
}

/**
 * Replace the shard with the given entries (used by `customers/redact` to
 * drop entries belonging to a redacted customer).
 */
export async function rebuildShard(
  client: AdminGqlClient,
  creds: ShopCreds,
  protectedOfferId: string,
  entries: ShardEntry[],
  opts: { maxSizeBytes?: number; shopSalt?: string } = {},
): Promise<{ entries: ShardEntry[]; bytes: number }> {
  const maxSize = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const shopSalt = opts.shopSalt ?? "";
  const trimmed = evictOldest(entries, maxSize, shopSalt);
  const value = serializeShard(trimmed, shopSalt);
  await metafieldsSet(client, [
    {
      ownerId: creds.shopGid,
      namespace: SHARD_NAMESPACE,
      key: shardKey(protectedOfferId),
      type: "json",
      value,
    },
  ]);
  return { entries: trimmed, bytes: Buffer.byteLength(value, "utf8") };
}
