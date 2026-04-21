/**
 * See: docs/function-queries-spec.md §9 (per-offer shard buckets, v2)
 *      docs/webhook-spec.md §5 (shard_append sub-job)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock admin-graphql + prisma so this suite stays a pure unit test.
type MfArg = Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }>;
const metafieldsSetMock = vi.fn(async (client: unknown, mfs: MfArg) => {
  void client;
  void mfs;
  return [{ id: "gid", key: "k" }];
});

vi.mock("./admin-graphql.server.js", async () => {
  return {
    metafieldsSet: (client: unknown, mfs: MfArg) =>
      metafieldsSetMock(client, mfs),
  };
});

const transactionMock = vi.fn(async (cb: (tx: unknown) => unknown) => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  return cb(tx);
});

vi.mock("../db.server.js", () => ({
  default: { $transaction: (cb: (tx: unknown) => unknown) => transactionMock(cb) },
}));

import {
  advisoryLockKey,
  appendEntry,
  dropOfferBucket,
  evictOldest,
  mergeEntry,
  newShard,
  parseShard,
  rebuildShard,
  serializeShard,
  setBucketMode,
  shardKey,
  SHARD_KEY,
  SHARD_NAMESPACE,
  type Shard,
  type ShardEntry,
} from "./shards.server.js";

const OFFER = "offer_A";
const OFFER_B = "offer_B";

function entry(
  ts: number,
  protectedOfferId = OFFER,
  overrides: Partial<ShardEntry> = {},
): ShardEntry {
  return {
    protectedOfferId,
    ts,
    phone: "deadbeef",
    email: "cafef00d",
    addr_full: "11111111",
    addr_house: "22222222",
    ip24: "33333333",
    device: "44444444",
    email_sketch: [1, 2, 3, 4],
    addr_sketch: [5, 6, 7, 8],
    ...overrides,
  };
}

describe("shardKey", () => {
  it("uses the v2 shop-wide key", () => {
    expect(shardKey()).toBe("shard_v2");
    expect(SHARD_KEY).toBe("shard_v2");
    expect(SHARD_NAMESPACE).toBe("$app");
  });
});

describe("newShard + serialize / parse", () => {
  it("serializes a fresh v2 shard and round-trips the contract fields", () => {
    const shard = newShard("deadbeef", "+84");
    const json = serializeShard(shard);
    const parsed = JSON.parse(json);
    expect(parsed.v).toBe(2);
    expect(parsed.salt_hex).toBe("deadbeef");
    expect(parsed.default_country_cc).toBe("+84");
    expect(parsed.offers).toEqual({});
    expect(parseShard(json)).toEqual(shard);
  });

  it("parseShard(null | empty) returns an empty shard with fallbacks", () => {
    expect(parseShard(null)).toEqual(newShard("", null));
    expect(parseShard(undefined)).toEqual(newShard("", null));
    expect(parseShard("", "salt", "+1")).toEqual(newShard("salt", "+1"));
  });

  it("parseShard tolerates corrupt JSON", () => {
    expect(parseShard("not json")).toEqual(newShard("", null));
    expect(parseShard("{")).toEqual(newShard("", null));
    expect(parseShard("[1,2,3]")).toEqual(newShard("", null));
  });

  it("parseShard discards v1 payloads (no auto-migrate; rebuild from DB)", () => {
    const v1 = JSON.stringify({
      v: 1,
      salt_hex: "abcdef",
      default_country_cc: "+1",
      phone_hashes: ["aabbccdd"],
    });
    const out = parseShard(v1);
    // Salt + cc are preserved; data is dropped.
    expect(out.v).toBe(2);
    expect(out.salt_hex).toBe("abcdef");
    expect(out.default_country_cc).toBe("+1");
    expect(out.offers).toEqual({});
  });

  it("parseShard drops malformed hex per-row inside each offer bucket", () => {
    const s: Shard = newShard("deadbeef", "+1");
    s.offers[OFFER] = {
      mode: "block",
      entry_ts: [1, 2, 3],
      phone_hashes: ["aabbccdd", "not-hex", "11223344"],
      email_hashes: [],
      address_full_hashes: [],
      address_house_hashes: [],
      ip_hashes: [],
      device_hashes: [],
      email_sketches: ["1".repeat(32), "short", "g".repeat(32)],
      address_sketches: [],
    };
    const parsed = parseShard(serializeShard(s));
    expect(parsed.offers[OFFER].phone_hashes).toEqual(["aabbccdd", "11223344"]);
    expect(parsed.offers[OFFER].email_sketches).toEqual(["1".repeat(32)]);
  });
});

describe("mergeEntry", () => {
  it("creates an offer bucket with the requested mode on first append", () => {
    const shard = newShard();
    const merged = mergeEntry(shard, entry(1700000000), "watch");
    const bucket = merged.offers[OFFER];
    expect(bucket.mode).toBe("watch");
    expect(bucket.entry_ts).toEqual([1700000000]);
    expect(bucket.phone_hashes).toEqual(["deadbeef"]);
    expect(bucket.email_hashes).toEqual(["cafef00d"]);
    expect(bucket.address_full_hashes).toEqual(["11111111"]);
    expect(bucket.address_house_hashes).toEqual(["22222222"]);
    expect(bucket.ip_hashes).toEqual(["33333333"]);
    expect(bucket.device_hashes).toEqual(["44444444"]);
    expect(bucket.email_sketches).toEqual([
      "00000001" + "00000002" + "00000003" + "00000004",
    ]);
    expect(bucket.address_sketches).toEqual([
      "00000005" + "00000006" + "00000007" + "00000008",
    ]);
  });

  it("appends to an existing bucket without changing its stored mode", () => {
    let shard = newShard();
    shard = mergeEntry(shard, entry(1), "watch");
    shard = mergeEntry(shard, entry(2), "block"); // would-be mode is ignored
    const bucket = shard.offers[OFFER];
    expect(bucket.mode).toBe("watch");
    expect(bucket.entry_ts).toEqual([1, 2]);
  });

  it("isolates offers — different offers get separate buckets", () => {
    let shard = newShard();
    shard = mergeEntry(shard, entry(1, OFFER));
    shard = mergeEntry(shard, entry(2, OFFER_B));
    expect(Object.keys(shard.offers).sort()).toEqual([OFFER, OFFER_B]);
    expect(shard.offers[OFFER].entry_ts).toEqual([1]);
    expect(shard.offers[OFFER_B].entry_ts).toEqual([2]);
  });

  it("drops empty-string hashes and all-zero sketches", () => {
    const shard = newShard();
    const sparse = entry(1, OFFER, {
      phone: "",
      addr_full: "",
      addr_house: "",
      ip24: "",
      device: "",
      email_sketch: [0, 0, 0, 0],
      addr_sketch: [0, 0, 0, 0],
    });
    const merged = mergeEntry(shard, sparse);
    const bucket = merged.offers[OFFER];
    expect(bucket.phone_hashes).toEqual([]);
    expect(bucket.email_hashes).toEqual(["cafef00d"]);
    expect(bucket.email_sketches).toEqual([]);
    expect(bucket.address_sketches).toEqual([]);
  });
});

describe("setBucketMode + dropOfferBucket", () => {
  it("setBucketMode flips an existing bucket's mode without touching data", () => {
    let shard = newShard();
    shard = mergeEntry(shard, entry(1), "block");
    shard = setBucketMode(shard, OFFER, "watch");
    expect(shard.offers[OFFER].mode).toBe("watch");
    expect(shard.offers[OFFER].entry_ts).toEqual([1]);
  });

  it("setBucketMode creates an empty bucket if absent", () => {
    let shard = newShard();
    shard = setBucketMode(shard, OFFER, "watch");
    expect(shard.offers[OFFER].mode).toBe("watch");
    expect(shard.offers[OFFER].entry_ts).toEqual([]);
  });

  it("dropOfferBucket removes the bucket entirely", () => {
    let shard = newShard();
    shard = mergeEntry(shard, entry(1));
    shard = dropOfferBucket(shard, OFFER);
    expect(shard.offers[OFFER]).toBeUndefined();
  });
});

describe("evictOldest", () => {
  it("returns input unchanged when within cap", () => {
    const shard = mergeEntry(newShard(), entry(1));
    const out = evictOldest(shard, 10_240);
    expect(out.offers[OFFER].phone_hashes).toHaveLength(1);
  });

  it("pops the globally-oldest entry across all offers", () => {
    let shard = newShard("deadbeef", "+84");
    // 30 entries on offer A (older) + 30 on offer B (newer) — eviction should
    // drain offer A first while offer B's newest entries survive.
    for (let i = 0; i < 30; i++) {
      shard = mergeEntry(shard, entry(1_000 + i, OFFER));
    }
    for (let i = 0; i < 30; i++) {
      shard = mergeEntry(shard, entry(2_000 + i, OFFER_B));
    }

    const trimmed = evictOldest(shard, 1_024);
    const bytes = Buffer.byteLength(serializeShard(trimmed), "utf8");
    expect(bytes).toBeLessThanOrEqual(1_024);

    const aSize = trimmed.offers[OFFER]?.entry_ts.length ?? 0;
    const bSize = trimmed.offers[OFFER_B]?.entry_ts.length ?? 0;
    // Offer B (newer) should retain more entries than offer A.
    expect(bSize).toBeGreaterThan(aSize);
    // Newest-of-B survives.
    if (bSize > 0) {
      const tail = trimmed.offers[OFFER_B].entry_ts;
      expect(tail[tail.length - 1]).toBe(2_029);
    }
  });

  it("removes a bucket entirely once fully drained", () => {
    let shard = newShard();
    for (let i = 0; i < 5; i++) {
      shard = mergeEntry(shard, entry(i, OFFER));
    }
    const trimmed = evictOldest(shard, 1);
    expect(trimmed.offers[OFFER]).toBeUndefined();
  });
});

describe("advisoryLockKey", () => {
  it("is deterministic for the same shop", () => {
    expect(advisoryLockKey("shop.myshopify.com")).toBe(
      advisoryLockKey("shop.myshopify.com"),
    );
  });

  it("differs across shops", () => {
    expect(advisoryLockKey("shop-a.myshopify.com")).not.toBe(
      advisoryLockKey("shop-b.myshopify.com"),
    );
  });

  it("fits in a signed 64-bit range", () => {
    const k = advisoryLockKey("a.myshopify.com");
    expect(k).toBeGreaterThanOrEqual(-(1n << 63n));
    expect(k).toBeLessThan(1n << 63n);
  });
});

describe("appendEntry", () => {
  beforeEach(() => {
    metafieldsSetMock.mockClear();
    transactionMock.mockClear();
  });

  function makeClient(metafieldValue: string | null) {
    return vi.fn(async () => ({
      status: 200,
      json: async () => ({
        data: {
          shop: { metafield: metafieldValue ? { value: metafieldValue } : null },
        },
      }),
    })) as unknown as Parameters<typeof appendEntry>[0];
  }

  it("writes a fresh per-offer bucket on first append", async () => {
    const client = makeClient(null);
    const e = entry(1_700_000_001);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid://shopify/Shop/1" },
      e,
      { saltHex: "deadbeef", defaultCountryCc: "+1", bucketMode: "block" },
    );
    expect(result.shard.offers[OFFER].phone_hashes).toEqual(["deadbeef"]);
    expect(metafieldsSetMock).toHaveBeenCalledTimes(1);
    const call = metafieldsSetMock.mock.calls[0];
    const mfs = call[1] as Array<{ key: string; namespace: string; value: string }>;
    expect(mfs[0].key).toBe("shard_v2");
    expect(mfs[0].namespace).toBe("$app");
    const written = JSON.parse(mfs[0].value);
    expect(written.v).toBe(2);
    expect(written.salt_hex).toBe("deadbeef");
    expect(written.default_country_cc).toBe("+1");
    expect(written.offers[OFFER].entry_ts).toEqual([1_700_000_001]);
    expect(written.offers[OFFER].mode).toBe("block");
  });

  it("appends into an existing bucket and stays under the cap", async () => {
    let seeded = newShard("salt", "+1");
    seeded = mergeEntry(seeded, entry(100));
    seeded = mergeEntry(seeded, entry(200));
    const client = makeClient(serializeShard(seeded));
    const e = entry(300);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid://shopify/Shop/1" },
      e,
      { saltHex: "salt", defaultCountryCc: "+1" },
    );
    expect(result.shard.offers[OFFER].entry_ts).toEqual([100, 200, 300]);
    expect(result.shard.offers[OFFER].phone_hashes).toHaveLength(3);
  });

  it("evicts oldest entries (globally) when the cap would be blown", async () => {
    let seeded = newShard("deadbeef", null);
    for (let i = 0; i < 100; i++) {
      seeded = mergeEntry(seeded, entry(1_000 + i));
    }
    const client = makeClient(serializeShard(seeded));
    const newEntry = entry(9_999_999);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid" },
      newEntry,
      { maxSizeBytes: 1_024, saltHex: "deadbeef" },
    );
    expect(result.bytes).toBeLessThanOrEqual(1_024);
    const tail = result.shard.offers[OFFER].entry_ts;
    expect(tail[tail.length - 1]).toBe(9_999_999);
    expect(tail.length).toBeLessThan(101);
  });
});

describe("rebuildShard", () => {
  beforeEach(() => {
    metafieldsSetMock.mockClear();
  });

  it("writes the given shard verbatim (after eviction trim)", async () => {
    let shard = newShard("s", null);
    shard = mergeEntry(shard, entry(10));
    shard = mergeEntry(shard, entry(20));
    shard = mergeEntry(shard, entry(30));
    const result = await rebuildShard(
      vi.fn() as unknown as Parameters<typeof rebuildShard>[0],
      { shopDomain: "s", shopGid: "gid" },
      shard,
    );
    expect(result.shard.offers[OFFER].entry_ts).toEqual([10, 20, 30]);
    expect(metafieldsSetMock).toHaveBeenCalledTimes(1);
    const call = metafieldsSetMock.mock.calls[0];
    const mfs = call[1] as Array<{ key: string; namespace: string }>;
    expect(mfs[0].namespace).toBe("$app");
    expect(mfs[0].key).toBe("shard_v2");
  });
});
