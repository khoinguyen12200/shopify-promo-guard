/**
 * See: docs/platform-admin-spec.md §13 (flags apply within 60s)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn(async (args: unknown): Promise<unknown> => {
  void args;
  return null;
});
const upsertMock = vi.fn(async (args: unknown): Promise<unknown> => {
  void args;
  return {};
});
const deleteManyMock = vi.fn(
  async (args: unknown): Promise<{ count: number }> => {
    void args;
    return { count: 0 };
  },
);
const updateMock = vi.fn(async (args: unknown): Promise<unknown> => {
  void args;
  return {};
});

vi.mock("../db.server.js", () => ({
  default: {
    featureFlag: {
      findUnique: (args: unknown) => findUniqueMock(args),
      update: (args: unknown) => updateMock(args),
    },
    featureFlagOverride: {
      upsert: (args: unknown) => upsertMock(args),
      deleteMany: (args: unknown) => deleteManyMock(args),
    },
  },
}));

import {
  __resetFeatureFlagCacheForTests,
  isEnabled,
  setDefault,
  setOverride,
} from "./feature-flags.server.js";

beforeEach(() => {
  __resetFeatureFlagCacheForTests();
  findUniqueMock.mockReset();
  upsertMock.mockReset();
  deleteManyMock.mockReset();
  updateMock.mockReset();
  upsertMock.mockResolvedValue({});
  deleteManyMock.mockResolvedValue({ count: 0 });
  updateMock.mockResolvedValue({});
});

describe("isEnabled", () => {
  it("returns the default when no shop override exists", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "f-1",
      defaultValue: true,
      overrides: [],
    });
    expect(await isEnabled("minhash_v2", "shop-1")).toBe(true);
  });

  it("prefers shop override over default", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "f-1",
      defaultValue: true,
      overrides: [{ value: false }],
    });
    expect(await isEnabled("minhash_v2", "shop-1")).toBe(false);
  });

  it("returns false for unknown flags", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    expect(await isEnabled("unknown", null)).toBe(false);
  });

  it("caches results (second read doesn't hit Prisma)", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "f-1",
      defaultValue: true,
      overrides: [],
    });
    await isEnabled("minhash_v2", "shop-1");
    await isEnabled("minhash_v2", "shop-1");
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });
});

describe("setOverride", () => {
  it("invalidates the cache so the next read sees the new value", async () => {
    findUniqueMock
      .mockResolvedValueOnce({
        id: "f-1",
        defaultValue: true,
        overrides: [],
      }) // initial read
      .mockResolvedValueOnce({ id: "f-1" }) // setOverride lookup
      .mockResolvedValueOnce({
        id: "f-1",
        defaultValue: true,
        overrides: [{ value: false }],
      }); // post-invalidation read

    expect(await isEnabled("minhash_v2", "shop-1")).toBe(true);
    await setOverride({
      flagKey: "minhash_v2",
      shopId: "shop-1",
      value: false,
    });
    expect(await isEnabled("minhash_v2", "shop-1")).toBe(false);
  });

  it("deletes the override when value is null", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "f-1" });
    await setOverride({
      flagKey: "minhash_v2",
      shopId: "shop-1",
      value: null,
    });
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("throws on unknown flag", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    await expect(
      setOverride({
        flagKey: "nope",
        shopId: "shop-1",
        value: true,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("setDefault", () => {
  it("clears every cache entry for the given flag", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "f-1",
      defaultValue: true,
      overrides: [],
    });
    await isEnabled("minhash_v2", "shop-1"); // prime cache

    findUniqueMock.mockResolvedValueOnce({
      id: "f-1",
      defaultValue: false,
      overrides: [],
    });

    await setDefault({ flagKey: "minhash_v2", value: false });
    // Next read must hit Prisma again.
    expect(await isEnabled("minhash_v2", "shop-1")).toBe(false);
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
  });
});
