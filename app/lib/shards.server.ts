/**
 * See: docs/function-queries-spec.md §9 (Plan C — single combined shop-wide shard),
 *      docs/webhook-spec.md §5 (shard_append sub-job)
 *
 * Plan C shard: a single shop-wide metafield at
 *   namespace="$app", key="shard_v1"   (app-reserved, no extra scope needed)
 * containing parallel-array hash lists read by the Validation Function and the
 * Discount Function. Schema:
 *
 *   {
 *     "v": 1,
 *     "salt_hex": "<hex of shop salt bytes>",
 *     "default_country_cc": "+1" | null,
 *     "phone_hashes":         ["a1b2c3d4", ...],
 *     "email_hashes":         ["..."],
 *     "address_full_hashes":  ["..."],
 *     "address_house_hashes": ["..."],
 *     "ip_hashes":            ["..."],
 *     "device_hashes":        ["..."],
 *     "email_sketches":       ["32-char hex", ...],
 *     "address_sketches":     ["..."]
 *   }
 *
 * Eviction is LRU-style: the metafield has a per-entry timestamp kept
 * out-of-band in `entry_ts` (parallel to the other arrays) so we can drop
 * oldest entries across ALL signal lists together when the serialized shard
 * exceeds the 10 KB metafield cap. Concurrent appends for the same shop are
 * serialized via a Postgres advisory lock keyed by `shopDomain`.
 */
import { createHash } from "node:crypto";

import prisma from "../db.server.js";

import {
  type AdminGqlClient,
  metafieldsSet,
} from "./admin-graphql.server.js";

// -- Constants --------------------------------------------------------------

export const SHARD_VERSION = 1 as const;
// App-reserved namespace — no extra scope needed to read/write; the
// authenticated app has full control of metafields under $app.
export const SHARD_NAMESPACE = "$app" as const;
export const SHARD_KEY = "shard_v1" as const;
export const DEFAULT_MAX_SIZE_BYTES = 10_240;

/** Shop-wide shard key. Same value for every offer on the shop. */
export function shardKey(): string {
  return SHARD_KEY;
}

// -- Types ------------------------------------------------------------------

/**
 * A single redemption's contribution to the shard, before being split across
 * the parallel hash/sketch arrays. Empty-string hashes are dropped at append
 * time so the persisted arrays never contain placeholder rows.
 */
export interface ShardEntry {
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

/** Plan C shard shape as written to (and read from) the shop metafield. */
export interface Shard {
  v: typeof SHARD_VERSION;
  salt_hex: string;
  default_country_cc: string | null;
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

// -- Serialize / parse ------------------------------------------------------

export function serializeShard(shard: Shard): string {
  return JSON.stringify(shard);
}

/**
 * Parse a shard JSON string. Tolerates null, corrupt payloads, and malformed
 * entries (per-row filtering) so a single bad hash cannot take the shop
 * offline — any missing field becomes empty / null.
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

  const obj = parsed as Partial<Record<keyof Shard, unknown>>;
  const saltHex =
    typeof obj.salt_hex === "string" ? obj.salt_hex : fallbackSalt;
  const cc =
    typeof obj.default_country_cc === "string"
      ? obj.default_country_cc
      : fallbackCc;
  const entryTs = Array.isArray(obj.entry_ts)
    ? (obj.entry_ts.filter((v) => typeof v === "number") as number[])
    : [];

  return {
    v: SHARD_VERSION,
    salt_hex: saltHex,
    default_country_cc: cc,
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

// -- Append an entry --------------------------------------------------------

/**
 * Merge a single `ShardEntry` into a parsed shard. Each non-empty signal is
 * pushed onto its respective array. `entry_ts` tracks the timestamp of *this*
 * entry so future eviction can drop the oldest as one logical unit.
 *
 * Note: eviction below operates on array indices, but the hash arrays from
 * different signals may have different lengths (e.g. a redemption with phone
 * but no address). We track evict-order via `entry_ts`, which is the earliest
 * timestamp associated with each index position; eviction lops the front of
 * every array simultaneously to keep things simple and bounded.
 */
export function mergeEntry(shard: Shard, entry: ShardEntry): Shard {
  const push = (arr: string[], v: string) => {
    if (v && HEX8.test(v)) arr.push(v);
  };

  const out: Shard = {
    ...shard,
    entry_ts: [...shard.entry_ts, entry.ts],
    phone_hashes: [...shard.phone_hashes],
    email_hashes: [...shard.email_hashes],
    address_full_hashes: [...shard.address_full_hashes],
    address_house_hashes: [...shard.address_house_hashes],
    ip_hashes: [...shard.ip_hashes],
    device_hashes: [...shard.device_hashes],
    email_sketches: [...shard.email_sketches],
    address_sketches: [...shard.address_sketches],
  };

  push(out.phone_hashes, entry.phone);
  push(out.email_hashes, entry.email);
  push(out.address_full_hashes, entry.addr_full);
  push(out.address_house_hashes, entry.addr_house);
  push(out.ip_hashes, entry.ip24);
  push(out.device_hashes, entry.device);
  if (!isSketchZero(entry.email_sketch)) {
    out.email_sketches.push(sketchToHex(entry.email_sketch));
  }
  if (!isSketchZero(entry.addr_sketch)) {
    out.address_sketches.push(sketchToHex(entry.addr_sketch));
  }

  return out;
}

// -- Eviction ---------------------------------------------------------------

/**
 * Drop from the front (oldest) across every array until the serialized shard
 * is within `maxSizeBytes`. Each array is trimmed independently but governed
 * by the same front-pop cadence so the newest entries always survive.
 */
export function evictOldest(
  shard: Shard,
  maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
): Shard {
  let out: Shard = { ...shard };
  while (Buffer.byteLength(serializeShard(out), "utf8") > maxSizeBytes) {
    const anyLeft =
      out.entry_ts.length > 0 ||
      out.phone_hashes.length > 0 ||
      out.email_hashes.length > 0 ||
      out.address_full_hashes.length > 0 ||
      out.address_house_hashes.length > 0 ||
      out.ip_hashes.length > 0 ||
      out.device_hashes.length > 0 ||
      out.email_sketches.length > 0 ||
      out.address_sketches.length > 0;
    if (!anyLeft) break;
    out = {
      ...out,
      entry_ts: out.entry_ts.slice(1),
      phone_hashes: out.phone_hashes.slice(1),
      email_hashes: out.email_hashes.slice(1),
      address_full_hashes: out.address_full_hashes.slice(1),
      address_house_hashes: out.address_house_hashes.slice(1),
      ip_hashes: out.ip_hashes.slice(1),
      device_hashes: out.device_hashes.slice(1),
      email_sketches: out.email_sketches.slice(1),
      address_sketches: out.address_sketches.slice(1),
    };
  }
  return out;
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
 * Plan C uses a shop-wide shard, so the lock is per-shop (not per-offer).
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
}

/**
 * Read the current shop-wide shard, merge `entry`, evict oldest until under
 * cap, and write back. Wrapped in a Postgres transaction holding an advisory
 * lock so concurrent appends for the same shop don't trample each other.
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
  const lockKey = advisoryLockKey(creds.shopDomain);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    const raw = await getShopMetafield(client, SHARD_NAMESPACE, SHARD_KEY);
    const existing = parseShard(raw, saltHex, defaultCc);
    // Salt / default_country_cc are controlled by the writer, not the shard
    // contents — stamp them on every write so salt rotation propagates.
    existing.salt_hex = saltHex;
    existing.default_country_cc = defaultCc;

    const ts = entry.ts || Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const merged = mergeEntry(existing, { ...entry, ts });
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
 * `customers/redact` and `rotate_salt` to rebuild from a DB hydration).
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
