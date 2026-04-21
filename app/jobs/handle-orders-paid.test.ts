/**
 * See: docs/webhook-spec.md §5 (orders/paid)
 *      docs/scoring-spec.md §5.2 (post-order scoring)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  enqueueJobMock,
  scorePostOrderMock,
  orderRiskAssessmentCreateMock,
  tagsAddMock,
  unauthenticatedAdminMock,
  loadKekMock,
  unwrapDekMock,
  encryptMock,
} = vi.hoisted(() => ({
  prismaMock: {
    shop: { findUnique: vi.fn() },
    protectedOffer: { findMany: vi.fn() },
    redemptionRecord: { create: vi.fn() },
    flaggedOrder: { create: vi.fn() },
  },
  enqueueJobMock: vi.fn(),
  scorePostOrderMock: vi.fn(),
  orderRiskAssessmentCreateMock: vi.fn(),
  tagsAddMock: vi.fn(),
  unauthenticatedAdminMock: vi.fn(),
  loadKekMock: vi.fn(),
  unwrapDekMock: vi.fn(),
  encryptMock: vi.fn(),
}));

vi.mock("../db.server.js", () => ({ default: prismaMock }));

vi.mock("../lib/jobs.server.js", () => ({
  enqueueJob: enqueueJobMock,
}));

vi.mock("../lib/scoring/score.server.js", () => ({
  scorePostOrder: scorePostOrderMock,
}));

vi.mock("../lib/admin-graphql.server.js", () => ({
  orderRiskAssessmentCreate: orderRiskAssessmentCreateMock,
  tagsAdd: tagsAddMock,
}));

vi.mock("../shopify.server.js", () => ({
  unauthenticated: { admin: unauthenticatedAdminMock },
}));

vi.mock("../lib/crypto.server.js", () => ({
  loadKek: loadKekMock,
  unwrapDek: unwrapDekMock,
  encrypt: encryptMock,
}));

import { handleOrdersPaid } from "./handle-orders-paid.js";

const ctx = {
  jobId: "job-1",
  shopId: "shop-1",
  updateProgress: async () => {},
};

const SHOP = {
  id: "shop-1",
  shopDomain: "test.myshopify.com",
  shopifyShopId: "gid://shopify/Shop/1",
  salt: "00".repeat(32),
  encryptionKey: "wrapped",
};

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    shopDomain: SHOP.shopDomain,
    orderJson: {
      id: 123,
      admin_graphql_api_id: "gid://shopify/Order/123",
      name: "#1001",
      email: "buyer@example.com",
      phone: "+15551234567",
      browser_ip: "1.2.3.4",
      discount_codes: [{ code: "WELCOME10" }],
      shipping_address: {
        address1: "1 Main St",
        city: "Anywhere",
        zip: "94000",
        country_code: "US",
      },
      customer: { id: 1, admin_graphql_api_id: "gid://shopify/Customer/1" },
      ...overrides,
    },
  };
}

beforeEach(() => {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group)) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  enqueueJobMock.mockReset();
  scorePostOrderMock.mockReset();
  orderRiskAssessmentCreateMock.mockReset();
  tagsAddMock.mockReset();
  unauthenticatedAdminMock.mockReset();
  loadKekMock.mockReset();
  unwrapDekMock.mockReset();
  encryptMock.mockReset();

  prismaMock.shop.findUnique.mockResolvedValue(SHOP);
  unauthenticatedAdminMock.mockResolvedValue({
    admin: { graphql: vi.fn() },
    session: { id: "999" },
  });
  loadKekMock.mockReturnValue(Buffer.alloc(32));
  unwrapDekMock.mockReturnValue(Buffer.alloc(32));
  encryptMock.mockImplementation((s: string) => `enc:${s}`);
  orderRiskAssessmentCreateMock.mockResolvedValue({
    riskAssessmentId: "gid://ra/1",
  });
  tagsAddMock.mockResolvedValue({ node: { id: "x", tags: [] } });
  prismaMock.redemptionRecord.create.mockResolvedValue({
    id: "rec-1",
    createdAt: new Date(0),
  });
  prismaMock.flaggedOrder.create.mockResolvedValue({ id: "flag-1" });
});

describe("handleOrdersPaid", () => {
  it("rejects malformed payloads", async () => {
    await expect(handleOrdersPaid({}, ctx)).rejects.toThrow(/orders_paid/);
  });

  it("no-ops when no codes match a protected offer", async () => {
    prismaMock.protectedOffer.findMany.mockResolvedValue([]);
    await handleOrdersPaid(basePayload(), ctx);
    expect(prismaMock.redemptionRecord.create).not.toHaveBeenCalled();
    expect(prismaMock.flaggedOrder.create).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
    expect(orderRiskAssessmentCreateMock).not.toHaveBeenCalled();
  });

  it("inserts RedemptionRecord + enqueues shard_append (no flag) for new buyer", async () => {
    prismaMock.protectedOffer.findMany.mockResolvedValue([
      {
        id: "offer-A",
        shopId: "shop-1",
        code: "WELCOME10",
        codeUpper: "WELCOME10",
      },
    ]);
    scorePostOrderMock.mockResolvedValue({
      score: 0,
      decision: "allow",
      matchedSignals: [],
      hashes: {
        email_canonical: "abcd1234",
        phone: "ffeedd11",
        address_full: "11223344",
        address_house: "11220000",
        ip_v4_24: "deadbeef",
      },
    });

    await handleOrdersPaid(basePayload(), ctx);

    expect(prismaMock.redemptionRecord.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.flaggedOrder.create).not.toHaveBeenCalled();
    expect(orderRiskAssessmentCreateMock).not.toHaveBeenCalled();
    // The customer is tagged as a known redeemer on every non-zero-score or
    // zero-score redemption — the Function's customer-tag fast path depends
    // on this (docs/function-queries-spec.md §9).
    expect(tagsAddMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Customer/1",
      ["promo-guard-redeemed"],
    );
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shard_append",
        shopId: "shop-1",
        payload: expect.objectContaining({
          shopDomain: SHOP.shopDomain,
          saltHex: SHOP.salt,
        }),
      }),
    );
  });

  it("flags + creates risk assessment + tags order on prior-match buyer", async () => {
    prismaMock.protectedOffer.findMany.mockResolvedValue([
      {
        id: "offer-A",
        shopId: "shop-1",
        code: "WELCOME10",
        codeUpper: "WELCOME10",
      },
    ]);
    scorePostOrderMock.mockResolvedValue({
      score: 12,
      decision: "block",
      matchedSignals: ["phone", "address_full"],
      hashes: {
        email_canonical: "abcd1234",
        phone: "ffeedd11",
        address_full: "11223344",
        address_house: "11220000",
        ip_v4_24: "deadbeef",
      },
    });

    await handleOrdersPaid(basePayload(), ctx);

    expect(prismaMock.flaggedOrder.create).toHaveBeenCalledTimes(1);
    const flagArgs = prismaMock.flaggedOrder.create.mock.calls[0][0];
    expect(flagArgs.data.riskLevel).toBe("HIGH");
    expect(flagArgs.data.score).toBe(12);

    expect(orderRiskAssessmentCreateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: "gid://shopify/Order/123",
        riskLevel: "HIGH",
      }),
    );
    expect(tagsAddMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/123",
      ["promo-guard-flagged"],
    );
    // Also tags the customer shop-wide.
    expect(tagsAddMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Customer/1",
      ["promo-guard-redeemed"],
    );
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shard_append" }),
    );
  });

  it("uses MEDIUM risk level for review decisions", async () => {
    prismaMock.protectedOffer.findMany.mockResolvedValue([
      {
        id: "offer-A",
        shopId: "shop-1",
        code: "WELCOME10",
        codeUpper: "WELCOME10",
      },
    ]);
    scorePostOrderMock.mockResolvedValue({
      score: 6,
      decision: "review",
      matchedSignals: ["email_fuzzy_strong"],
      hashes: { email_canonical: "abcd1234" },
    });

    await handleOrdersPaid(basePayload(), ctx);

    expect(orderRiskAssessmentCreateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ riskLevel: "MEDIUM" }),
    );
  });
});
