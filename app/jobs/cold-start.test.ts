/**
 * See: docs/system-design.md § Cold start (backfill from order history)
 * Related: app/jobs/cold-start.ts, docs/scoring-spec.md §5.2
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  enqueueJobMock,
  unauthenticatedAdminMock,
  loadKekMock,
  unwrapDekMock,
  encryptMock,
} = vi.hoisted(() => ({
  prismaMock: {
    shop: { findUnique: vi.fn() },
    protectedOffer: { findUnique: vi.fn(), update: vi.fn() },
    redemptionRecord: { findUnique: vi.fn(), create: vi.fn() },
  },
  enqueueJobMock: vi.fn(),
  unauthenticatedAdminMock: vi.fn(),
  loadKekMock: vi.fn(),
  unwrapDekMock: vi.fn(),
  encryptMock: vi.fn(),
}));

vi.mock("../db.server.js", () => ({ default: prismaMock }));

vi.mock("../lib/jobs.server.js", () => ({
  enqueueJob: enqueueJobMock,
}));

vi.mock("../shopify.server.js", () => ({
  unauthenticated: { admin: unauthenticatedAdminMock },
}));

vi.mock("../lib/crypto.server.js", () => ({
  loadKek: loadKekMock,
  unwrapDek: unwrapDekMock,
  encrypt: encryptMock,
}));

import {
  ColdStartThrottledError,
  MAX_PAGES_PER_RUN,
  handleColdStart,
} from "./cold-start.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHOP = {
  id: "shop-1",
  shopDomain: "test.myshopify.com",
  shopifyShopId: "gid://shopify/Shop/1",
  salt: "00".repeat(32),
  encryptionKey: "wrapped",
};

function ctx(overrides: Partial<{ shopId: string }> = {}) {
  return {
    jobId: "job-1",
    shopId: overrides.shopId ?? SHOP.id,
    updateProgress: vi.fn(async () => {}),
  };
}

function offerWithCodes(codes: string[], extra: Record<string, unknown> = {}) {
  return {
    id: "offer-A",
    shopId: SHOP.id,
    archivedAt: null,
    coldStartStatus: "pending",
    coldStartDone: 0,
    coldStartTotal: 0,
    codes: codes.map((c, i) => ({
      id: `pc-${i}`,
      codeUpper: c.toUpperCase(),
      code: c,
      addedAt: new Date(),
      archivedAt: null,
    })),
    ...extra,
  };
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Order/999",
    name: "#9001",
    email: "a@b.com",
    phone: "+15551234567",
    clientIp: "1.2.3.4",
    customer: { id: "gid://shopify/Customer/42", phone: null },
    discountCodes: ["WELCOME10"],
    shippingAddress: {
      address1: "1 Main St",
      address2: null,
      city: "Anywhere",
      zip: "94000",
      countryCodeV2: "US",
    },
    billingAddress: null,
    ...overrides,
  };
}

/**
 * Build a fake `admin.graphql` client that returns the given pages in order.
 * Each "page" is an `orders` connection payload.
 */
function fakeAdminClient(
  pages: Array<
    | { edges: Array<{ node: Record<string, unknown> }>; hasNextPage: boolean; endCursor: string | null }
    | { error: "throttled" | string }
  >,
): { graphql: ReturnType<typeof vi.fn>; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const graphql = vi.fn(
    async (_q: string, opts: { variables: Record<string, unknown> }) => {
      calls.push(opts.variables);
      const step = pages[Math.min(i, pages.length - 1)];
      i++;
      if ("error" in step) {
        if (step.error === "throttled") {
          return {
            json: async () => ({
              errors: [
                {
                  message: "Throttled",
                  extensions: { code: "THROTTLED" },
                },
              ],
            }),
          };
        }
        return {
          json: async () => ({ errors: [{ message: step.error }] }),
        };
      }
      return {
        json: async () => ({
          data: {
            orders: {
              pageInfo: {
                hasNextPage: step.hasNextPage,
                endCursor: step.endCursor,
              },
              edges: step.edges,
            },
          },
        }),
      };
    },
  );
  return { graphql, calls };
}

beforeEach(() => {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group)) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  enqueueJobMock.mockReset();
  unauthenticatedAdminMock.mockReset();
  loadKekMock.mockReset();
  unwrapDekMock.mockReset();
  encryptMock.mockReset();

  prismaMock.shop.findUnique.mockResolvedValue(SHOP);
  loadKekMock.mockReturnValue(Buffer.alloc(32));
  unwrapDekMock.mockReturnValue(Buffer.alloc(32));
  encryptMock.mockImplementation((s: unknown) => `enc:${String(s)}`);
  // Default: no existing RedemptionRecord.
  prismaMock.redemptionRecord.findUnique.mockResolvedValue(null);
  prismaMock.redemptionRecord.create.mockImplementation(
    async ({ data }: { data: { orderGid: string } }) => ({
      id: `rec-${data.orderGid}`,
      createdAt: new Date(0),
    }),
  );
  prismaMock.protectedOffer.update.mockResolvedValue({
    coldStartDone: 0,
    coldStartTotal: 0,
  });
});

describe("handleColdStart — payload validation", () => {
  it("throws on missing protectedOfferId", async () => {
    await expect(handleColdStart({}, ctx())).rejects.toThrow(
      /protectedOfferId/,
    );
  });

  it("returns silently when shop row is gone", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(null);
    await expect(
      handleColdStart({ protectedOfferId: "offer-A" }, ctx()),
    ).resolves.toBeUndefined();
    expect(prismaMock.protectedOffer.findUnique).not.toHaveBeenCalled();
  });

  it("returns silently when offer is archived or belongs to another shop", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue({
      ...offerWithCodes(["X"]),
      archivedAt: new Date(),
    });
    await expect(
      handleColdStart({ protectedOfferId: "offer-A" }, ctx()),
    ).resolves.toBeUndefined();
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });
});

describe("handleColdStart — happy path", () => {
  it("marks complete + zero work when offer has no codes", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes([]),
    );
    await handleColdStart({ protectedOfferId: "offer-A" }, ctx());

    // One update: status → complete. (No running bump, since we skip straight
    // to complete when there's nothing to do.)
    const updates = prismaMock.protectedOffer.update.mock.calls;
    expect(updates.at(-1)?.[0].data.coldStartStatus).toBe("complete");
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it("paginates a single code, inserts records, enqueues shard_append per new row", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["welcome10"]),
    );

    const client = fakeAdminClient([
      {
        edges: [
          { node: makeOrder({ id: "gid://shopify/Order/1", name: "#1" }) },
          { node: makeOrder({ id: "gid://shopify/Order/2", name: "#2" }) },
        ],
        hasNextPage: true,
        endCursor: "CURSOR_1",
      },
      {
        edges: [
          { node: makeOrder({ id: "gid://shopify/Order/3", name: "#3" }) },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-1" },
    });

    await handleColdStart({ protectedOfferId: "offer-A" }, ctx());

    // 3 inserted records → 3 shard_append enqueues.
    expect(prismaMock.redemptionRecord.create).toHaveBeenCalledTimes(3);
    const shardAppendCalls = enqueueJobMock.mock.calls.filter(
      (c) => c[0].type === "shard_append",
    );
    expect(shardAppendCalls).toHaveLength(3);
    for (const [args] of shardAppendCalls) {
      expect(args.payload.saltHex).toBe(SHOP.salt);
      expect(args.payload.shopDomain).toBe(SHOP.shopDomain);
      expect(args.shopId).toBe(SHOP.id);
    }

    // Paginator: second call carried the cursor returned from the first.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].cursor).toBeNull();
    expect(client.calls[0].query).toBe("discount_code:WELCOME10");
    expect(client.calls[1].cursor).toBe("CURSOR_1");

    // Status transitions: pending → running → complete.
    const statuses = prismaMock.protectedOffer.update.mock.calls
      .map((c) => (c[0].data.coldStartStatus as string | undefined))
      .filter((s): s is string => typeof s === "string");
    expect(statuses[0]).toBe("running");
    expect(statuses.at(-1)).toBe("complete");

    // No continuation scheduled.
    const coldStartContinuations = enqueueJobMock.mock.calls.filter(
      (c) => c[0].type === "cold_start",
    );
    expect(coldStartContinuations).toHaveLength(0);
  });

  it("walks multiple codes in order, restarting cursor for each", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["a", "b"]),
    );

    const client = fakeAdminClient([
      {
        edges: [{ node: makeOrder({ id: "gid://shopify/Order/a1" }) }],
        hasNextPage: false,
        endCursor: null,
      },
      {
        edges: [{ node: makeOrder({ id: "gid://shopify/Order/b1" }) }],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-2" },
    });

    await handleColdStart({ protectedOfferId: "offer-A" }, ctx());

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].query).toBe("discount_code:A");
    expect(client.calls[1].query).toBe("discount_code:B");
    // Both started with a null cursor (new code resets pagination).
    expect(client.calls[0].cursor).toBeNull();
    expect(client.calls[1].cursor).toBeNull();
  });

  it("is idempotent: pre-existing RedemptionRecords are skipped", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["welcome10"]),
    );
    // Simulate the first order already present; the second fresh.
    prismaMock.redemptionRecord.findUnique.mockImplementation(
      async ({
        where,
      }: {
        where: {
          shopId_orderGid_protectedOfferId: { orderGid: string };
        };
      }) => {
        return where.shopId_orderGid_protectedOfferId.orderGid ===
          "gid://shopify/Order/1"
          ? { id: "existing" }
          : null;
      },
    );

    const client = fakeAdminClient([
      {
        edges: [
          { node: makeOrder({ id: "gid://shopify/Order/1" }) },
          { node: makeOrder({ id: "gid://shopify/Order/2" }) },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-3" },
    });

    await handleColdStart({ protectedOfferId: "offer-A" }, ctx());

    expect(prismaMock.redemptionRecord.create).toHaveBeenCalledTimes(1);
    // Only the freshly-inserted order enqueues a shard_append.
    const shardAppendCalls = enqueueJobMock.mock.calls.filter(
      (c) => c[0].type === "shard_append",
    );
    expect(shardAppendCalls).toHaveLength(1);
  });
});

describe("handleColdStart — continuation + throttle", () => {
  it("re-enqueues itself when MAX_PAGES_PER_RUN is reached", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["welcome10"]),
    );

    // Always hasNextPage=true → we'd loop forever without the page cap.
    const pages = Array.from({ length: MAX_PAGES_PER_RUN + 2 }, (_, idx) => ({
      edges: [
        { node: makeOrder({ id: `gid://shopify/Order/${idx}` }) },
      ],
      hasNextPage: true,
      endCursor: `CURSOR_${idx}`,
    }));
    const client = fakeAdminClient(pages);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-4" },
    });

    await handleColdStart({ protectedOfferId: "offer-A" }, ctx());

    // Exactly MAX_PAGES_PER_RUN pages fetched before we stop.
    expect(client.graphql).toHaveBeenCalledTimes(MAX_PAGES_PER_RUN);

    const continuations = enqueueJobMock.mock.calls.filter(
      (c) => c[0].type === "cold_start",
    );
    expect(continuations).toHaveLength(1);
    const contArgs = continuations[0][0];
    expect(contArgs.payload.protectedOfferId).toBe("offer-A");
    expect(contArgs.payload.codeIndex).toBe(0);
    // The cursor carried forward matches the last page we consumed.
    expect(contArgs.payload.cursor).toBe(
      `CURSOR_${MAX_PAGES_PER_RUN - 1}`,
    );

    // Status stays running (don't mark complete when handing off).
    const statuses = prismaMock.protectedOffer.update.mock.calls
      .map((c) => (c[0].data.coldStartStatus as string | undefined))
      .filter((s): s is string => typeof s === "string");
    expect(statuses).not.toContain("complete");
  });

  it("resumes from a checkpointed payload (codeIndex + cursor)", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["a", "b"], { coldStartStatus: "running" }),
    );

    const client = fakeAdminClient([
      {
        edges: [{ node: makeOrder({ id: "gid://shopify/Order/b2" }) }],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-5" },
    });

    await handleColdStart(
      {
        protectedOfferId: "offer-A",
        codeIndex: 1,
        cursor: "CURSOR_B",
      },
      ctx(),
    );

    // We should skip code "a" entirely and resume on code "b" with the given cursor.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toBe("discount_code:B");
    expect(client.calls[0].cursor).toBe("CURSOR_B");

    // Running-already: no redundant status="running" write on entry.
    const statusWrites = prismaMock.protectedOffer.update.mock.calls
      .map((c) => c[0].data.coldStartStatus as string | undefined)
      .filter((s): s is string => typeof s === "string");
    expect(statusWrites.filter((s) => s === "running")).toHaveLength(0);
    expect(statusWrites.at(-1)).toBe("complete");
  });

  it("throws ColdStartThrottledError on Shopify THROTTLED response", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["welcome10"]),
    );
    const client = fakeAdminClient([{ error: "throttled" }]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-6" },
    });

    await expect(
      handleColdStart({ protectedOfferId: "offer-A" }, ctx()),
    ).rejects.toBeInstanceOf(ColdStartThrottledError);

    // No completion on throttle.
    const statuses = prismaMock.protectedOffer.update.mock.calls
      .map((c) => c[0].data.coldStartStatus as string | undefined)
      .filter((s): s is string => typeof s === "string");
    expect(statuses).not.toContain("complete");
  });
});

describe("handleColdStart — privacy invariants", () => {
  it("writes only ciphertext + hashes to RedemptionRecord, no raw email/phone/address/ip columns", async () => {
    prismaMock.protectedOffer.findUnique.mockResolvedValue(
      offerWithCodes(["welcome10"]),
    );
    const client = fakeAdminClient([
      {
        edges: [{ node: makeOrder() }],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    unauthenticatedAdminMock.mockResolvedValue({
      admin: { graphql: client.graphql },
      session: { id: "sess-7" },
    });

    await handleColdStart({ protectedOfferId: "offer-A" }, ctx());

    expect(prismaMock.redemptionRecord.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.redemptionRecord.create.mock.calls[0][0].data;

    // Ciphertexts present (mock prepends "enc:").
    expect(String(data.emailCiphertext).startsWith("enc:")).toBe(true);
    expect(String(data.phoneCiphertext).startsWith("enc:")).toBe(true);
    expect(String(data.addressCiphertext).startsWith("enc:")).toBe(true);
    expect(String(data.ipCiphertext).startsWith("enc:")).toBe(true);

    // Hashes look like hex (fnv1a_32 → 8 chars) and are not the raw values.
    for (const field of [
      "emailCanonicalHash",
      "phoneHash",
      "addressFullHash",
      "ipHash24",
    ] as const) {
      const h = data[field] as string | null;
      expect(h).toMatch(/^[0-9a-f]{8}$/);
      // Sanity: no raw email or phone leaked into the hash column.
      expect(h).not.toContain("a@b.com");
      expect(h).not.toContain("1.2.3.4");
    }

    // The shard_append payload carries hashes, not plaintext.
    const shardPayload = enqueueJobMock.mock.calls.find(
      (c) => c[0].type === "shard_append",
    )?.[0].payload;
    const entry = shardPayload.entry as Record<string, unknown>;
    for (const k of [
      "phone",
      "email",
      "addr_full",
      "addr_house",
      "ip24",
      "device",
    ] as const) {
      const v = entry[k] as string;
      expect(v).not.toContain("a@b.com");
      expect(v).not.toContain("1.2.3.4");
      expect(v).not.toContain("+15551234567");
    }
  });
});
