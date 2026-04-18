/**
 * See: docs/webhook-spec.md §7 (customers/redact worker)
 * Related: app/jobs/compliance-customer-redact.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  tagsRemoveMock,
  rebuildShardMock,
  unauthenticatedAdminMock,
} = vi.hoisted(() => ({
  prismaMock: {
    complianceRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    shop: {
      findUnique: vi.fn(),
    },
    redemptionRecord: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  tagsRemoveMock: vi.fn(),
  rebuildShardMock: vi.fn(),
  unauthenticatedAdminMock: vi.fn(),
}));

vi.mock("../db.server.js", () => ({
  default: prismaMock,
}));

vi.mock("../lib/admin-graphql.server.js", () => ({
  tagsRemove: tagsRemoveMock,
}));

// Keep real mergeEntry/newShard so the hydration path is actually exercised.
vi.mock("../lib/shards.server.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/shards.server.js")>(
      "../lib/shards.server.js",
    );
  return {
    ...actual,
    rebuildShard: rebuildShardMock,
  };
});

vi.mock("../shopify.server.js", () => ({
  unauthenticated: {
    admin: unauthenticatedAdminMock,
  },
}));

import { complianceCustomerRedactHandler } from "./compliance-customer-redact.js";

const ctx = {
  jobId: "job-1",
  shopId: "shop-1",
  updateProgress: async () => {},
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    shopId: "shop-1",
    protectedOfferId: "offer-A",
    customerGid: "gid://shopify/Customer/42",
    orderGid: "gid://shopify/Order/1",
    orderName: "#1001",
    codeUsed: "WELCOME10",
    phoneHash: "aabbccdd",
    emailCanonicalHash: "11223344",
    addressFullHash: "55667788",
    ipHash24: "99aabbcc",
    emailMinhashSketch: null,
    addressMinhashSketch: null,
    emailCiphertext: null,
    phoneCiphertext: null,
    addressCiphertext: null,
    ipCiphertext: null,
    createdAt: new Date(1_700_000_000_000),
    ...overrides,
  };
}

describe("complianceCustomerRedactHandler", () => {
  beforeEach(() => {
    Object.values(prismaMock).forEach((g) =>
      Object.values(g).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset()),
    );
    tagsRemoveMock.mockReset();
    rebuildShardMock.mockReset();
    unauthenticatedAdminMock.mockReset();
  });

  it("rejects payloads without complianceRequestId", async () => {
    await expect(
      complianceCustomerRedactHandler({}, ctx),
    ).rejects.toThrow(/complianceRequestId/);
  });

  it("returns early when ComplianceRequest is missing", async () => {
    prismaMock.complianceRequest.findUnique.mockResolvedValue(null);
    await complianceCustomerRedactHandler(
      { complianceRequestId: "cr-1" },
      ctx,
    );
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("returns early when ComplianceRequest already completed", async () => {
    prismaMock.complianceRequest.findUnique.mockResolvedValue({
      id: "cr-1",
      status: "completed",
      shopId: "shop-1",
      customerGid: "gid://shopify/Customer/1",
    });
    await complianceCustomerRedactHandler(
      { complianceRequestId: "cr-1" },
      ctx,
    );
    expect(prismaMock.redemptionRecord.findMany).not.toHaveBeenCalled();
  });

  it("nulls PII, rebuilds the shop-wide shard, removes tag, marks completed", async () => {
    prismaMock.complianceRequest.findUnique.mockResolvedValue({
      id: "cr-1",
      status: "pending",
      shopId: "shop-1",
      customerGid: "gid://shopify/Customer/42",
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "test.myshopify.com",
      salt: "00".repeat(32),
    });
    prismaMock.redemptionRecord.findMany
      // 1st call: records belonging to the redacted customer
      .mockResolvedValueOnce([
        record({ id: "r1", protectedOfferId: "offer-A" }),
        record({ id: "r2", protectedOfferId: "offer-B" }),
      ])
      // 2nd call: remaining rows for the shop after nulling
      .mockResolvedValueOnce([
        record({
          id: "r3",
          protectedOfferId: "offer-A",
          customerGid: "gid://shopify/Customer/other",
        }),
      ]);
    prismaMock.redemptionRecord.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.complianceRequest.update.mockResolvedValue({});
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: vi.fn() },
      session: { id: "1" },
    });
    rebuildShardMock.mockResolvedValue({ shard: null, bytes: 0 });
    tagsRemoveMock.mockResolvedValue({ node: { id: "x", tags: [] } });

    await complianceCustomerRedactHandler(
      { complianceRequestId: "cr-1" },
      ctx,
    );

    expect(prismaMock.redemptionRecord.updateMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", customerGid: "gid://shopify/Customer/42" },
      data: expect.objectContaining({
        customerGid: null,
        emailCiphertext: null,
        phoneHash: null,
        emailMinhashSketch: null,
      }),
    });

    // Shard is rebuilt once (shop-wide), carrying the surviving record's hashes.
    expect(rebuildShardMock).toHaveBeenCalledTimes(1);
    const rebuildArgs = rebuildShardMock.mock.calls[0];
    const passedShard = rebuildArgs[2];
    expect(passedShard.phone_hashes).toContain("aabbccdd");
    expect(passedShard.email_hashes).toContain("11223344");

    expect(tagsRemoveMock).toHaveBeenCalledTimes(1);
    const [, gid, tags] = tagsRemoveMock.mock.calls[0];
    expect(gid).toBe("gid://shopify/Customer/42");
    expect(tags).toEqual(["promo-guard-redeemed"]);
    expect(prismaMock.complianceRequest.update).toHaveBeenLastCalledWith({
      where: { id: "cr-1" },
      data: expect.objectContaining({ status: "completed" }),
    });
  });

  it("marks completed with no work when there are no redemption records", async () => {
    prismaMock.complianceRequest.findUnique.mockResolvedValue({
      id: "cr-1",
      status: "pending",
      shopId: "shop-1",
      customerGid: "gid://shopify/Customer/42",
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "test.myshopify.com",
      salt: "00".repeat(32),
    });
    prismaMock.redemptionRecord.findMany.mockResolvedValueOnce([]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: vi.fn() },
      session: { id: "1" },
    });
    prismaMock.complianceRequest.update.mockResolvedValue({});

    await complianceCustomerRedactHandler(
      { complianceRequestId: "cr-1" },
      ctx,
    );

    expect(prismaMock.redemptionRecord.updateMany).not.toHaveBeenCalled();
    expect(rebuildShardMock).not.toHaveBeenCalled();
    expect(tagsRemoveMock).not.toHaveBeenCalled();
    expect(prismaMock.complianceRequest.update).toHaveBeenCalledWith({
      where: { id: "cr-1" },
      data: expect.objectContaining({ status: "completed" }),
    });
  });
});
