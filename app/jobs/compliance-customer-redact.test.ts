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

vi.mock("../lib/shards.server.js", () => ({
  rebuildShard: rebuildShardMock,
}));

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

  it("nulls PII, rebuilds shards, removes tags, marks completed", async () => {
    prismaMock.complianceRequest.findUnique.mockResolvedValue({
      id: "cr-1",
      status: "pending",
      shopId: "shop-1",
      customerGid: "gid://shopify/Customer/42",
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "test.myshopify.com",
    });
    prismaMock.redemptionRecord.findMany
      .mockResolvedValueOnce([
        {
          id: "r1",
          shopId: "shop-1",
          protectedOfferId: "offer-A",
          customerGid: "gid://shopify/Customer/42",
        },
        {
          id: "r2",
          shopId: "shop-1",
          protectedOfferId: "offer-B",
          customerGid: "gid://shopify/Customer/42",
        },
      ])
      // remaining for offer-A
      .mockResolvedValueOnce([])
      // remaining for offer-B
      .mockResolvedValueOnce([]);
    prismaMock.redemptionRecord.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.complianceRequest.update.mockResolvedValue({});
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: vi.fn() },
      session: { id: "1" },
    });
    rebuildShardMock.mockResolvedValue({ entries: [], bytes: 0 });
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
    expect(rebuildShardMock).toHaveBeenCalledTimes(2);
    expect(tagsRemoveMock).toHaveBeenCalledTimes(1);
    const [, gid, tags] = tagsRemoveMock.mock.calls[0];
    expect(gid).toBe("gid://shopify/Customer/42");
    expect(tags).toEqual(
      expect.arrayContaining([
        "pg-redeemed-offer-A",
        "pg-redeemed-offer-B",
        "promo-guard-flag",
      ]),
    );
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
