/**
 * See: docs/function-queries-spec.md §9 (Per-offer shard buckets — v2),
 *      docs/webhook-spec.md §5 (shard_append sub-job)
 *
 * v2 shard: a single shop-wide metafield at
 *   namespace="$app", key="shard_v2"   (app-reserved, no extra scope needed)
 * containing a per-offer map of hash buckets read by the Validation Function.
 * Per-offer segmentation is required for correctness: with one code per
 * protected offer, a buyer matching offer A's ledger should NOT be blocked
 * when redeeming a different offer B for the first time.
 *
 * Schema:
 *
 *   {
 *     "v": 2,
 *     "salt_hex": "<hex of shop salt bytes>",
 *     "default_country_cc": "+1" | null,
 *     "offers": {
 *       "<protectedOfferId>": {
 *         "mode": "block" | "watch",
 *         "entry_ts":             [1700000001, ...],
 *         "phone_hashes":         ["a1b2c3d4", ...],
 *         "email_hashes":         ["..."],
 *         "address_full_hashes":  ["..."],
 *         "address_house_hashes": ["..."],
 *         "ip_hashes":            ["..."],
 *         "device_hashes":        ["..."],
 *         "email_sketches":       ["32-char hex", ...],
 *         "address_sketches":     ["..."]
 *       },
 *       ...
 *     }
 *   }
 *
 * Eviction is global LRU: when the serialized shard exceeds the cap, find the
 * offer with the oldest entry and drop its oldest. Concurrent appends for the
 * same shop are serialized via a Postgres advisory lock keyed by `shopDomain`.
 */
import { createHash } from "node:crypto";

import prisma from "../db.server.js";

import {
  type AdminGqlClient,
  metafieldsSet,
} from "./admin-graphql.server.js";

// -- Constants --------------------------------------------------------------

export const SHARD_VERSION = 2 as const;
// App-reserved namespace — no extra scope needed to read/write; the
// authenticated app has full control of metafields under $app.
export const SHARD_NAMESPACE = "$app" as const;
export const SHARD_KEY = "shard_v2" as const;
export const DEFAULT_MAX_SIZE_BYTES = 10_240;

/** Shop-wide shard key. Same value for every offer on the shop. */
export function shardKey(): string {
  return SHARD_KEY;
}

// -- Types ------------------------------------------------------------------

export type OfferMode = "block" | "watch";

/**
 * A single redemption's contribution to the shard, before being routed into
 * its owning offer's bucket. Empty-string hashes are dropped at append time
 * so the persisted arrays never contain placeholder rows.
 */
export interface ShardEntry {
  /** Which protected offer this redemption belongs to. */
  protectedOfferId: string;
  /** unix seconds — used for LRU eviction */
  ts: number;
  /** 8-char hex u32, or "" when the signal wasn't available */
  phone: string;
  email: string;
  addr_full: string;
  addr_house: string;
  ip24: string;
  device: string;
  /** 4 u32s — all zero means "no sketch" and the row is dropped */
  email_sketch: [number, number, number, number];
  addr_sketch: [number, number, number, number];
}

/** Per-offer bucket of hashes + sketches, plus the offer's enforcement mode. */
export interface OfferBucket {
  mode: OfferMode;
  entry_ts: number[];
  phone_hashes: string[];
  email_hashes: string[];
  address_full_hashes: string[];
  address_house_hashes: string[];
  ip_hashes: string[];
  device_hashes: string[];
  email_sketches: string[];
  address_sketches: string[];
}

/** v2 shard shape as written to (and read from) the shop metafield. */
export interface Shard {
  v: typeof SHARD_VERSION;
  salt_hex: string;
  default_country_cc: string | null;
  offers: Record<string, OfferBucket>;
}

export interface ShopCreds {
  shopDomain: string;
  /** GID of the Shop owner for the metafield (e.g. "gid://shopify/Shop/123") */
  shopGid: string;
}

// -- Helpers ----------------------------------------------------------------

const HEX8 = /^[0-9a-fA-F]{8}$/;
const HEX32 = /^[0-9a-fA-F]{32}$/;

function sketchToHex(s: [number, number, number, number]): string {
  return s.map((u) => (u >>> 0).toString(16).padStart(8, "0")).join("");
}

function isSketchZero(s: [number, number, number, number]): boolean {
  return s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0;
}

function emptyShard(saltHex = "", defaultCountryCc: string | null = null): Shard {
  return {
    v: SHARD_VERSION,
    salt_hex: saltHex,
    default_country_cc: defaultCountryCc,
    offers: {},
  };
}

export function emptyBucket(mode: OfferMode = "block"): OfferBucket {
  return {
    mode,
    entry_ts: [],
    phone_hashes: [],
    email_hashes: [],
    address_full_hashes: [],
    address_house_hashes: [],
    ip_hashes: [],
    device_hashes: [],
    email_sketches: [],
    address_sketches: [],
  };
}

function filterHashArray(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  return xs.filter(
    (v): v is string => typeof v === "string" && HEX8.test(v),
  );
}

function filterSketchArray(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  return xs.filter(
    (v): v is string => typeof v === "string" && HEX32.test(v),
  );
}

function parseMode(v: unknown): OfferMode {
  return v === "watch" ? "watch" : "block";
}

function parseBucket(v: unknown): OfferBucket {
  if (!v || typeof v !== "object") return emptyBucket();
  const obj = v as Partial<Record<keyof OfferBucket, unknown>>;
  const entryTs = Array.isArray(obj.entry_ts)
    ? (obj.entry_ts.filter((x) => typeof x === "number") as number[])
    : [];
  return {
    mode: parseMode(obj.mode),
    entry_ts: entryTs,
    phone_hashes: filterHashArray(obj.phone_hashes),
    email_hashes: filterHashArray(obj.email_hashes),
    address_full_hashes: filterHashArray(obj.address_full_hashes),
    address_house_hashes: filterHashArray(obj.address_house_hashes),
    ip_hashes: filterHashArray(obj.ip_hashes),
    device_hashes: filterHashArray(obj.device_hashes),
    email_sketches: filterSketchArray(obj.email_sketches),
    address_sketches: filterSketchArray(obj.address_sketches),
  };
}

// -- Serialize / parse ------------------------------------------------------

export function serializeShard(shard: Shard): string {
  return JSON.stringify(shard);
}

/**
 * Parse a shard JSON string. Tolerates null, corrupt payloads, and malformed
 * entries (per-row filtering) so a single bad hash cannot take the shop
 * offline. Unknown shard versions are coerced to an empty v2 shard so the next
 * append starts the new structure cleanly.
 */
export function parseShard(
  raw: string | null | undefined,
  fallbackSalt = "",
  fallbackCc: string | null = null,
): Shard {
  if (!raw) return emptyShard(fallbackSalt, fallbackCc);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyShard(fallbackSalt, fallbackCc);
  }
  if (!parsed || typeof parsed !== "object") {
    return emptyShard(fallbackSalt, fallbackCc);
  }

  const obj = parsed as Record<string, unknown>;
  const saltHex =
    typeof obj.salt_hex === "string" ? obj.salt_hex : fallbackSalt;
  const cc =
    typeof obj.default_country_cc === "string"
      ? obj.default_country_cc
      : fallbackCc;

  // Anything that isn't a v2 object → fresh empty shard. We don't auto-migrate
  // v1 data; the shard is just a fingerprint cache and re-fills naturally.
  if (obj.v !== SHARD_VERSION || !obj.offers || typeof obj.offers !== "object") {
    return emptyShard(saltHex, cc);
  }

  const offers: Record<string, OfferBucket> = {};
  for (const [offerId, bucket] of Object.entries(obj.offers as Record<string, unknown>)) {
    if (!offerId) continue;
    offers[offerId] = parseBucket(bucket);
  }

  return {
    v: SHARD_VERSION,
    salt_hex: saltHex,
    default_country_cc: cc,
    offers,
  };
}

// -- Append an entry --------------------------------------------------------

/**
 * Merge a single `ShardEntry` into a parsed shard, into the bucket for
 * `entry.protectedOfferId`. The bucket is created if missing using
 * `bucketMode` (default "block"). Existing buckets keep their stored mode —
 * use `setOfferMode` to change it.
 */
export function mergeEntry(
  shard: Shard,
  entry: ShardEntry,
  bucketMode: OfferMode = "block",
): Shard {
  const offers: Record<string, OfferBucket> = { ...shard.offers };
  const existing = offers[entry.protectedOfferId];
  const bucket: OfferBucket = existing
    ? cloneBucket(existing)
    : emptyBucket(bucketMode);

  const push = (arr: string[], v: string) => {
    if (v && HEX8.test(v)) arr.push(v);
  };

  bucket.entry_ts.push(entry.ts);
  push(bucket.phone_hashes, entry.phone);
  push(bucket.email_hashes, entry.email);
  push(bucket.address_full_hashes, entry.addr_full);
  push(bucket.address_house_hashes, entry.addr_house);
  push(bucket.ip_hashes, entry.ip24);
  push(bucket.device_hashes, entry.device);
  if (!isSketchZero(entry.email_sketch)) {
    bucket.email_sketches.push(sketchToHex(entry.email_sketch));
  }
  if (!isSketchZero(entry.addr_sketch)) {
    bucket.address_sketches.push(sketchToHex(entry.addr_sketch));
  }

  offers[entry.protectedOfferId] = bucket;
  return { ...shard, offers };
}

function cloneBucket(b: OfferBucket): OfferBucket {
  return {
    mode: b.mode,
    entry_ts: [...b.entry_ts],
    phone_hashes: [...b.phone_hashes],
    email_hashes: [...b.email_hashes],
    address_full_hashes: [...b.address_full_hashes],
    address_house_hashes: [...b.address_house_hashes],
    ip_hashes: [...b.ip_hashes],
    device_hashes: [...b.device_hashes],
    email_sketches: [...b.email_sketches],
    address_sketches: [...b.address_sketches],
  };
}

// -- Mode + lifecycle helpers ----------------------------------------------

/** Set the mode of an offer's bucket (creates an empty bucket if absent). */
export function setBucketMode(
  shard: Shard,
  protectedOfferId: string,
  mode: OfferMode,
): Shard {
  const offers = { ...shard.offers };
  const existing = offers[protectedOfferId];
  offers[protectedOfferId] = existing
    ? { ...cloneBucket(existing), mode }
    : emptyBucket(mode);
  return { ...shard, offers };
}

/** Remove an offer's entire bucket (used when deactivating or archiving). */
export function dropOfferBucket(
  shard: Shard,
  protectedOfferId: string,
): Shard {
  if (!shard.offers[protectedOfferId]) return shard;
  const offers = { ...shard.offers };
  delete offers[protectedOfferId];
  return { ...shard, offers };
}

// -- Eviction ---------------------------------------------------------------

/**
 * Drop the globally-oldest entry until the serialized shard fits. We pop from
 * whichever offer's bucket currently holds the oldest `entry_ts[0]`. Each pop
 * trims that bucket's parallel arrays in lockstep, keeping per-bucket
 * invariants intact.
 */
export function evictOldest(
  shard: Shard,
  maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
): Shard {
  let out: Shard = { ...shard, offers: { ...shard.offers } };
  while (Buffer.byteLength(serializeShard(out), "utf8") > maxSizeBytes) {
    let victimId: string | null = null;
    let victimTs = Infinity;
    for (const [offerId, bucket] of Object.entries(out.offers)) {
      const front = bucket.entry_ts[0];
      if (typeof front === "number" && front < victimTs) {
        victimTs = front;
        victimId = offerId;
      }
    }
    if (!victimId) break; // every bucket empty
    const target = out.offers[victimId];
    if (!target || target.entry_ts.length === 0) break;
    const trimmed = popFrontFromBucket(target);
    const offers = { ...out.offers };
    if (
      trimmed.entry_ts.length === 0 &&
      trimmed.phone_hashes.length === 0 &&
      trimmed.email_hashes.length === 0 &&
      trimmed.address_full_hashes.length === 0 &&
      trimmed.address_house_hashes.length === 0 &&
      trimmed.ip_hashes.length === 0 &&
      trimmed.device_hashes.length === 0 &&
      trimmed.email_sketches.length === 0 &&
      trimmed.address_sketches.length === 0
    ) {
      // Bucket fully drained — drop it from the offers map so we don't keep
      // re-considering an empty entry.
      delete offers[victimId];
    } else {
      offers[victimId] = trimmed;
    }
    out = { ...out, offers };
  }
  return out;
}

function popFrontFromBucket(b: OfferBucket): OfferBucket {
  return {
    mode: b.mode,
    entry_ts: b.entry_ts.slice(1),
    phone_hashes: b.phone_hashes.slice(1),
    email_hashes: b.email_hashes.slice(1),
    address_full_hashes: b.address_full_hashes.slice(1),
    address_house_hashes: b.address_house_hashes.slice(1),
    ip_hashes: b.ip_hashes.slice(1),
    device_hashes: b.device_hashes.slice(1),
    email_sketches: b.email_sketches.slice(1),
    address_sketches: b.address_sketches.slice(1),
  };
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
 * Map a `shopDomain` to a signed bigint suitable for `pg_advisory_xact_lock`.
 * We take the first 8 bytes of SHA-256 and reinterpret as signed 64-bit.
 * Lock is per-shop because the shard metafield is shop-wide.
 */
export function advisoryLockKey(shopDomain: string): bigint {
  const digest = createHash("sha256").update(shopDomain).digest();
  const u = digest.readBigUInt64BE(0);
  return u >= 1n << 63n ? u - (1n << 64n) : u;
}

// -- Append / rebuild -------------------------------------------------------

export interface ShardWriteOptions {
  /** Override `Date.now()` for tests. */
  nowMs?: number;
  /** Override the 10 KB cap (useful in tests). */
  maxSizeBytes?: number;
  /** Salt as hex — embedded into the shard so the Function can hash with it. */
  saltHex?: string;
  /** Default phone country code for E.164 normalization in the Function. */
  defaultCountryCc?: string | null;
  /** Mode to use if the offer's bucket doesn't exist yet. */
  bucketMode?: OfferMode;
}

/**
 * Read the current shop-wide shard, merge `entry` into its offer's bucket,
 * evict oldest until under cap, and write back. Wrapped in a Postgres
 * transaction holding an advisory lock so concurrent appends for the same
 * shop don't trample each other.
 */
export async function appendEntry(
  client: AdminGqlClient,
  creds: ShopCreds,
  entry: ShardEntry,
  opts: ShardWriteOptions = {},
): Promise<{ shard: Shard; bytes: number }> {
  const maxSize = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const saltHex = opts.saltHex ?? "";
  const defaultCc = opts.defaultCountryCc ?? null;
  const bucketMode = opts.bucketMode ?? "block";
  const lockKey = advisoryLockKey(creds.shopDomain);

  return prisma.$transaction(async (tx) => {
    // `pg_advisory_xact_lock` returns void — `$queryRaw` blows up trying to
    // deserialize the void column, so we use `$executeRaw` which doesn't
    // attempt to read a result set.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    const raw = await getShopMetafield(client, SHARD_NAMESPACE, SHARD_KEY);
    const existing = parseShard(raw, saltHex, defaultCc);
    // Salt / default_country_cc are controlled by the writer, not the shard
    // contents — stamp them on every write so salt rotation propagates.
    existing.salt_hex = saltHex;
    existing.default_country_cc = defaultCc;

    const ts = entry.ts || Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const merged = mergeEntry(existing, { ...entry, ts }, bucketMode);
    const trimmed = evictOldest(merged, maxSize);
    const value = serializeShard(trimmed);

    await metafieldsSet(client, [
      {
        ownerId: creds.shopGid,
        namespace: SHARD_NAMESPACE,
        key: SHARD_KEY,
        type: "json",
        value,
      },
    ]);

    return { shard: trimmed, bytes: Buffer.byteLength(value, "utf8") };
  });
}

/**
 * Overwrite the shop-wide shard with the given pre-assembled shard (used by
 * `customers/redact`, `rotate_salt`, and offer activation/mode toggles to
 * rebuild from a DB hydration).
 */
export async function rebuildShard(
  client: AdminGqlClient,
  creds: ShopCreds,
  shard: Shard,
  opts: { maxSizeBytes?: number } = {},
): Promise<{ shard: Shard; bytes: number }> {
  const maxSize = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const trimmed = evictOldest(shard, maxSize);
  const value = serializeShard(trimmed);
  await metafieldsSet(client, [
    {
      ownerId: creds.shopGid,
      namespace: SHARD_NAMESPACE,
      key: SHARD_KEY,
      type: "json",
      value,
    },
  ]);
  return { shard: trimmed, bytes: Buffer.byteLength(value, "utf8") };
}

/** Create an empty shard with salt + country stamped. */
export function newShard(
  saltHex = "",
  defaultCountryCc: string | null = null,
): Shard {
  return emptyShard(saltHex, defaultCountryCc);
}
