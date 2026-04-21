/**
 * See: app/lib/offer-service.server.ts
 *
 * Block-only enforcement, one code per offer. The service handles status
 * flips (with side effects: shard rebuild + Shopify validation toggle),
 * mode flips (shard rebuild), name updates, and soft-archive.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateManyMock = vi.fn(
  async (args: unknown): Promise<{ count: number }> => {
    void args;
    return { count: 1 };
  },
);
const countMock = vi.fn(async (): Promise<number> => 1);
const rebuildMock = vi.fn(async (client: unknown, args: unknown) => {
  void client;
  void args;
  return { shard: null as unknown, bytes: 0 };
});
const ensureValidationMock = vi.fn(
  async (client: unknown, enabled: boolean) => {
    void client;
    void enabled;
    return { id: "gid://shopify/Validation/1", enabled: true };
  },
);

vi.mock("../db.server.js", () => ({
  default: {
    protectedOffer: {
      updateMany: (args: unknown) => updateManyMock(args),
      count: () => countMock(),
    },
  },
}));

vi.mock("./shard-rebuild.server.js", () => ({
  rebuildShardForShop: (client: unknown, args: unknown) =>
    rebuildMock(client, args),
}));

vi.mock("./validation-lifecycle.server.js", () => ({
  ensureValidation: (client: unknown, enabled: boolean) =>
    ensureValidationMock(client, enabled),
}));

import {
  deleteOffer,
  setOfferMode,
  setOfferStatus,
  updateOfferFields,
} from "./offer-service.server.js";

const SHOP = {
  id: "shop-1",
  shopDomain: "x.myshopify.com",
  shopGid: "gid://shopify/Shop/1",
  saltHex: "deadbeef",
};

const fakeClient = {} as never;

beforeEach(() => {
  updateManyMock.mockClear();
  updateManyMock.mockImplementation(async () => ({ count: 1 }));
  countMock.mockClear();
  countMock.mockImplementation(async () => 1);
  rebuildMock.mockClear();
  ensureValidationMock.mockClear();
});

describe("setOfferStatus", () => {
  it("flips status and rebuilds the shard", async () => {
    await setOfferStatus({
      client: fakeClient,
      shop: SHOP,
      offerId: "offer-1",
      status: "inactive",
    });

    expect(updateManyMock.mock.calls[0]![0]).toEqual({
      where: { id: "offer-1", shopId: "shop-1", archivedAt: null },
      data: { status: "inactive" },
    });
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    // Checkout validation lifecycle is not managed from here while we
    // migrate enforcement to the Discount Function path.
    expect(ensureValidationMock).not.toHaveBeenCalled();
  });

  it("throws when no row matches (cross-shop attempt / archived)", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(
      setOfferStatus({
        client: fakeClient,
        shop: SHOP,
        offerId: "offer-1",
        status: "active",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("setOfferMode", () => {
  it("updates mode and rebuilds shard so the bucket flag flips", async () => {
    await setOfferMode({
      client: fakeClient,
      shop: SHOP,
      offerId: "offer-1",
      mode: "watch",
    });
    expect(updateManyMock.mock.calls[0]![0]).toEqual({
      where: { id: "offer-1", shopId: "shop-1", archivedAt: null },
      data: { mode: "watch" },
    });
    expect(rebuildMock).toHaveBeenCalledTimes(1);
  });

  it("throws on missing offer", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(
      setOfferMode({
        client: fakeClient,
        shop: SHOP,
        offerId: "missing",
        mode: "block",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("updateOfferFields", () => {
  it("only passes the provided fields through", async () => {
    await updateOfferFields({
      offerId: "offer-1",
      shopId: "shop-1",
      name: "renamed",
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "offer-1", shopId: "shop-1", archivedAt: null },
      data: { name: "renamed" },
    });
  });

  it("is a no-op when no fields are provided", async () => {
    const result = await updateOfferFields({
      offerId: "offer-1",
      shopId: "shop-1",
    });
    expect(result.updated).toBe(false);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe("deleteOffer", () => {
  it("soft-archives and rebuilds the shard", async () => {
    await deleteOffer({
      client: fakeClient,
      shop: SHOP,
      offerId: "offer-1",
    });

    const args = updateManyMock.mock.calls[0]![0] as {
      where: { id: string; shopId: string; archivedAt: null };
      data: { archivedAt: Date; status: string };
    };
    expect(args.where).toEqual({
      id: "offer-1",
      shopId: "shop-1",
      archivedAt: null,
    });
    expect(args.data.status).toBe("archived");
    expect(args.data.archivedAt).toBeInstanceOf(Date);
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(ensureValidationMock).not.toHaveBeenCalled();
  });

  it("throws when the offer doesn't exist for this shop", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(
      deleteOffer({
        client: fakeClient,
        shop: SHOP,
        offerId: "missing",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
