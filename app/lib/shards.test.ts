/**
 * See: docs/function-queries-spec.md §9 (Plan C shard shape)
 *      docs/webhook-spec.md §5 (shard_append sub-job)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the admin-graphql + prisma modules so this suite stays a pure unit
// test: no live Postgres for the appendEntry path, no real Shopify HTTP.
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
  // Provide a tx with a $queryRaw spy so the advisory lock call works.
  const tx = { $queryRaw: vi.fn(async () => []) };
  return cb(tx);
});

vi.mock("../db.server.js", () => ({
  default: { $transaction: (cb: (tx: unknown) => unknown) => transactionMock(cb) },
}));

import {
  advisoryLockKey,
  appendEntry,
  evictOldest,
  mergeEntry,
  newShard,
  parseShard,
  rebuildShard,
  serializeShard,
  shardKey,
  SHARD_KEY,
  SHARD_NAMESPACE,
  type Shard,
  type ShardEntry,
} from "./shards.server.js";

function entry(ts: number, overrides: Partial<ShardEntry> = {}): ShardEntry {
  return {
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
  it("is a shop-wide literal (no per-offer suffix)", () => {
    expect(shardKey()).toBe("shard_v1");
    expect(SHARD_KEY).toBe("shard_v1");
    expect(SHARD_NAMESPACE).toBe("promo_guard");
  });
});

describe("newShard + serialize / parse", () => {
  it("serializes a fresh shard and round-trips the contract fields", () => {
    const shard = newShard("deadbeef", "+84");
    const json = serializeShard(shard);
    const parsed = JSON.parse(json);
    expect(parsed.v).toBe(1);
    expect(parsed.salt_hex).toBe("deadbeef");
    expect(parsed.default_country_cc).toBe("+84");
    expect(parsed.phone_hashes).toEqual([]);
    expect(parsed.email_sketches).toEqual([]);
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

  it("parseShard drops malformed hex per-row", () => {
    const s: Shard = newShard("deadbeef", "+1");
    s.phone_hashes = ["aabbccdd", "not-hex", "11223344"];
    s.email_sketches = [
      "1".repeat(32),
      "short",
      "g".repeat(32),
    ];
    const parsed = parseShard(serializeShard(s));
    expect(parsed.phone_hashes).toEqual(["aabbccdd", "11223344"]);
    expect(parsed.email_sketches).toEqual(["1".repeat(32)]);
  });
});

describe("mergeEntry", () => {
  it("pushes non-empty hashes onto each parallel array", () => {
    const shard = newShard();
    const merged = mergeEntry(shard, entry(1700000000));
    expect(merged.entry_ts).toEqual([1700000000]);
    expect(merged.phone_hashes).toEqual(["deadbeef"]);
    expect(merged.email_hashes).toEqual(["cafef00d"]);
    expect(merged.address_full_hashes).toEqual(["11111111"]);
    expect(merged.address_house_hashes).toEqual(["22222222"]);
    expect(merged.ip_hashes).toEqual(["33333333"]);
    expect(merged.device_hashes).toEqual(["44444444"]);
    expect(merged.email_sketches).toEqual([
      "00000001" + "00000002" + "00000003" + "00000004",
    ]);
    expect(merged.address_sketches).toEqual([
      "00000005" + "00000006" + "00000007" + "00000008",
    ]);
  });

  it("drops empty-string hashes and all-zero sketches", () => {
    const shard = newShard();
    const sparse: ShardEntry = {
      ts: 1,
      phone: "",
      email: "cafef00d",
      addr_full: "",
      addr_house: "",
      ip24: "",
      device: "",
      email_sketch: [0, 0, 0, 0],
      addr_sketch: [0, 0, 0, 0],
    };
    const merged = mergeEntry(shard, sparse);
    expect(merged.phone_hashes).toEqual([]);
    expect(merged.email_hashes).toEqual(["cafef00d"]);
    expect(merged.email_sketches).toEqual([]);
    expect(merged.address_sketches).toEqual([]);
  });
});

describe("evictOldest", () => {
  it("returns input unchanged when within cap", () => {
    const shard = mergeEntry(newShard(), entry(1));
    const out = evictOldest(shard, 10_240);
    expect(out.phone_hashes).toHaveLength(1);
  });

  it("pops from the front until the serialized shard fits", () => {
    // Assemble 60 entries — each push adds ~8 bytes across 6 hash arrays plus
    // ~34 bytes across 2 sketch arrays. Blowing past 1 KB is ample.
    let shard = newShard("deadbeef", "+84");
    for (let i = 0; i < 60; i++) {
      shard = mergeEntry(shard, entry(1_700_000_000 + i));
    }
    const before = Buffer.byteLength(serializeShard(shard), "utf8");
    expect(before).toBeGreaterThan(1_024);

    const trimmed = evictOldest(shard, 1_024);
    const after = Buffer.byteLength(serializeShard(trimmed), "utf8");
    expect(after).toBeLessThanOrEqual(1_024);
    expect(trimmed.phone_hashes.length).toBeLessThan(shard.phone_hashes.length);
    // Newest ts survives (the last-pushed timestamp).
    expect(trimmed.entry_ts[trimmed.entry_ts.length - 1]).toBe(
      1_700_000_000 + 59,
    );
  });

  it("yields a near-empty shard when cap is tiny", () => {
    const shard = mergeEntry(mergeEntry(newShard(), entry(1)), entry(2));
    const trimmed = evictOldest(shard, 1);
    expect(trimmed.phone_hashes).toEqual([]);
    expect(trimmed.entry_ts).toEqual([]);
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

  it("writes a fresh shop-wide shard on first append", async () => {
    const client = makeClient(null);
    const e = entry(1_700_000_001);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid://shopify/Shop/1" },
      e,
      { saltHex: "deadbeef", defaultCountryCc: "+1" },
    );
    expect(result.shard.phone_hashes).toEqual(["deadbeef"]);
    expect(metafieldsSetMock).toHaveBeenCalledTimes(1);
    const call = metafieldsSetMock.mock.calls[0];
    const mfs = call[1] as Array<{ key: string; namespace: string; value: string }>;
    expect(mfs[0].key).toBe("shard_v1");
    expect(mfs[0].namespace).toBe("promo_guard");
    const written = JSON.parse(mfs[0].value);
    expect(written.v).toBe(1);
    expect(written.salt_hex).toBe("deadbeef");
    expect(written.default_country_cc).toBe("+1");
    expect(written.entry_ts).toEqual([1_700_000_001]);
  });

  it("appends into an existing shard and stays under the cap", async () => {
    const seeded = mergeEntry(
      mergeEntry(newShard("salt", "+1"), entry(100)),
      entry(200),
    );
    const client = makeClient(serializeShard(seeded));
    const e = entry(300);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid://shopify/Shop/1" },
      e,
      { saltHex: "salt", defaultCountryCc: "+1" },
    );
    expect(result.shard.entry_ts).toEqual([100, 200, 300]);
    expect(result.shard.phone_hashes).toHaveLength(3);
  });

  it("evicts oldest entries when the cap would be blown", async () => {
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
    // Newest timestamp must survive.
    expect(
      result.shard.entry_ts[result.shard.entry_ts.length - 1],
    ).toBe(9_999_999);
    expect(result.shard.entry_ts.length).toBeLessThan(101);
  });
});

describe("rebuildShard", () => {
  beforeEach(() => {
    metafieldsSetMock.mockClear();
  });

  it("writes the given shard verbatim (after eviction trim)", async () => {
    const shard = mergeEntry(
      mergeEntry(mergeEntry(newShard("s", null), entry(10)), entry(20)),
      entry(30),
    );
    const result = await rebuildShard(
      vi.fn() as unknown as Parameters<typeof rebuildShard>[0],
      { shopDomain: "s", shopGid: "gid" },
      shard,
    );
    expect(result.shard.entry_ts).toEqual([10, 20, 30]);
    expect(metafieldsSetMock).toHaveBeenCalledTimes(1);
    const call = metafieldsSetMock.mock.calls[0];
    const mfs = call[1] as Array<{ key: string; namespace: string }>;
    expect(mfs[0].namespace).toBe("promo_guard");
    expect(mfs[0].key).toBe("shard_v1");
  });
});
