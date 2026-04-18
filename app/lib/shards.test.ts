/**
 * See: docs/webhook-spec.md §5 (shard_append sub-job),
 *      docs/function-queries-spec.md §2 (shard format)
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
  parseShard,
  rebuildShard,
  serializeShard,
  shardKey,
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
  it("uses the v1 prefix and offer id", () => {
    expect(shardKey("offer_abc")).toBe("shard_v1_offer_abc");
  });
});

describe("serializeShard / parseShard", () => {
  it("round-trips a non-empty shard", () => {
    const entries = [entry(100), entry(200)];
    const json = serializeShard(entries, "saltyhex");
    const parsed = JSON.parse(json);
    expect(parsed.v).toBe(1);
    expect(parsed.shop_salt).toBe("saltyhex");
    expect(parsed.entries).toHaveLength(2);
    expect(parseShard(json)).toEqual(entries);
  });

  it("parseShard(null) returns []", () => {
    expect(parseShard(null)).toEqual([]);
    expect(parseShard(undefined)).toEqual([]);
    expect(parseShard("")).toEqual([]);
  });

  it("parseShard tolerates corrupt JSON", () => {
    expect(parseShard("not json")).toEqual([]);
    expect(parseShard("{")).toEqual([]);
    expect(parseShard("[1,2,3]")).toEqual([]); // not an object with entries
    expect(parseShard('{"entries":"not-array"}')).toEqual([]);
  });

  it("parseShard filters structurally-invalid entries", () => {
    const json = JSON.stringify({
      v: 1,
      entries: [entry(1), { not: "valid" }, null, entry(2)],
    });
    const parsed = parseShard(json);
    expect(parsed.map((e) => e.ts)).toEqual([1, 2]);
  });
});

describe("evictOldest", () => {
  it("returns input unchanged when within cap", () => {
    const entries = [entry(1), entry(2), entry(3)];
    const out = evictOldest(entries, 10_240);
    expect(out).toHaveLength(3);
  });

  it("drops oldest entries (lowest ts) until under cap", () => {
    // Build entries large enough that ~30 entries blow past 10 KB.
    const big: ShardEntry[] = [];
    for (let i = 0; i < 60; i++) {
      big.push(
        entry(1_700_000_000 + i, {
          email: "f".repeat(64),
          addr_full: "a".repeat(64),
          addr_house: "b".repeat(64),
        }),
      );
    }
    const beforeBytes = Buffer.byteLength(serializeShard(big), "utf8");
    expect(beforeBytes).toBeGreaterThan(10_240);

    const trimmed = evictOldest(big, 10_240);
    const afterBytes = Buffer.byteLength(serializeShard(trimmed), "utf8");
    expect(afterBytes).toBeLessThanOrEqual(10_240);
    expect(trimmed.length).toBeLessThan(big.length);

    // Newest entries survived — every kept ts is >= the smallest dropped ts.
    const keptMin = Math.min(...trimmed.map((e) => e.ts));
    const droppedTs = big
      .map((e) => e.ts)
      .filter((ts) => !trimmed.some((k) => k.ts === ts));
    for (const dts of droppedTs) {
      expect(dts).toBeLessThanOrEqual(keptMin);
    }
  });

  it("returns [] when cap is so small everything must go", () => {
    expect(evictOldest([entry(1), entry(2)], 5)).toEqual([]);
  });
});

describe("advisoryLockKey", () => {
  it("is deterministic for the same input", () => {
    expect(advisoryLockKey("shop.myshopify.com", "off_1")).toBe(
      advisoryLockKey("shop.myshopify.com", "off_1"),
    );
  });

  it("differs across offer ids", () => {
    expect(advisoryLockKey("shop.myshopify.com", "off_1")).not.toBe(
      advisoryLockKey("shop.myshopify.com", "off_2"),
    );
  });

  it("fits in a signed 64-bit range", () => {
    const k = advisoryLockKey("a", "b");
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
        data: { shop: { metafield: metafieldValue ? { value: metafieldValue } : null } },
      }),
    })) as unknown as Parameters<typeof appendEntry>[0];
  }

  it("creates an empty shard with one entry on first write", async () => {
    const client = makeClient(null);
    const e = entry(1_700_000_001);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid://shopify/Shop/1" },
      "off_1",
      e,
    );
    expect(result.entries).toEqual([e]);
    expect(metafieldsSetMock).toHaveBeenCalledTimes(1);
    const call = metafieldsSetMock.mock.calls[0];
    const mfs = call[1] as Array<{ key: string; namespace: string; value: string }>;
    expect(mfs[0].key).toBe("shard_v1_off_1");
    expect(mfs[0].namespace).toBe("promo_guard");
    const written = JSON.parse(mfs[0].value);
    expect(written.entries).toHaveLength(1);
    expect(written.v).toBe(1);
  });

  it("appends to existing entries and stays under the cap", async () => {
    const existing = serializeShard([entry(100), entry(200)], "salt");
    const client = makeClient(existing);
    const e = entry(300);
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid://shopify/Shop/1" },
      "off_x",
      e,
      { shopSalt: "salt" },
    );
    expect(result.entries.map((x) => x.ts).sort()).toEqual([100, 200, 300]);
  });

  it("evicts oldest entry when adding pushes past the cap", async () => {
    const big: ShardEntry[] = [];
    for (let i = 0; i < 60; i++) {
      big.push(
        entry(1_000 + i, {
          email: "f".repeat(64),
          addr_full: "a".repeat(64),
          addr_house: "b".repeat(64),
        }),
      );
    }
    const existing = serializeShard(big);
    const client = makeClient(existing);
    const newEntry = entry(9_999_999, {
      email: "f".repeat(64),
      addr_full: "a".repeat(64),
      addr_house: "b".repeat(64),
    });
    const result = await appendEntry(
      client,
      { shopDomain: "shop.myshopify.com", shopGid: "gid" },
      "off_evict",
      newEntry,
    );
    expect(result.bytes).toBeLessThanOrEqual(10_240);
    // Newest entry must survive.
    expect(result.entries.some((e) => e.ts === 9_999_999)).toBe(true);
    // Some old entries must have been dropped.
    expect(result.entries.length).toBeLessThan(big.length + 1);
  });
});

describe("rebuildShard", () => {
  beforeEach(() => {
    metafieldsSetMock.mockClear();
  });

  it("writes the given entries verbatim (after eviction trim)", async () => {
    const entries = [entry(10), entry(20), entry(30)];
    const result = await rebuildShard(
      vi.fn() as unknown as Parameters<typeof rebuildShard>[0],
      { shopDomain: "s", shopGid: "gid" },
      "off",
      entries,
    );
    expect(result.entries.map((e) => e.ts).sort()).toEqual([10, 20, 30]);
    expect(metafieldsSetMock).toHaveBeenCalledTimes(1);
  });
});
