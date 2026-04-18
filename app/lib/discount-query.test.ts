/**
 * See: docs/admin-ui-spec.md §5 (discount suggestion / code picker)
 * Related: app/lib/discount-query.server.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Prisma mock ------------------------------------------------------------

const findManyMock = vi.fn(
  async (args: unknown): Promise<Array<{ codeUpper: string }>> => {
    void args;
    return [];
  },
);

vi.mock("../db.server.js", () => ({
  default: {
    protectedCode: {
      findMany: (args: unknown) => findManyMock(args),
    },
  },
}));

import {
  suggestDiscounts,
  type DiscountSuggestion,
} from "./discount-query.server.js";
import type { AdminGqlClient } from "./admin-graphql.server.js";

// -- GraphQL mock client ----------------------------------------------------

interface FakeDiscount {
  id: string;
  title: string;
  status: string; // ACTIVE | EXPIRED | SCHEDULED
  appliesOncePerCustomer: boolean;
  codes: string[];
}

function nodeEdge(d: FakeDiscount) {
  return {
    node: {
      id: d.id,
      discount: {
        title: d.title,
        status: d.status,
        appliesOncePerCustomer: d.appliesOncePerCustomer,
        codes: { edges: d.codes.map((c) => ({ node: { code: c } })) },
      },
    },
  };
}

/**
 * Build a mock admin.graphql client that returns the given pages in order,
 * one per call. Each "page" is an array of FakeDiscount. hasNextPage is true
 * except for the final page.
 */
function makeClient(pages: FakeDiscount[][]): {
  client: AdminGqlClient;
  spy: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const spy = vi.fn(async (_query: string, _opts: unknown) => {
    void _query;
    void _opts;
    const page = pages[i] ?? [];
    const hasNextPage = i < pages.length - 1;
    i++;
    const body = {
      data: {
        discountNodes: {
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? `cursor_${i}` : null,
          },
          edges: page.map(nodeEdge),
        },
      },
    };
    return {
      status: 200,
      headers: new Headers(),
      json: async () => body,
    };
  });
  return { client: spy as unknown as AdminGqlClient, spy };
}

beforeEach(() => {
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([]);
});

// -- Tests ------------------------------------------------------------------

describe("suggestDiscounts", () => {
  it("returns results from a single page", async () => {
    const { client } = makeClient([
      [
        {
          id: "gid://shopify/DiscountCodeNode/1",
          title: "Welcome 10",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["WELCOME10"],
        },
        {
          id: "gid://shopify/DiscountCodeNode/2",
          title: "Summer sale",
          status: "ACTIVE",
          appliesOncePerCustomer: false,
          codes: ["SUMMER"],
        },
      ],
    ]);

    const out = await suggestDiscounts({ client, shopId: "shop_1" });
    expect(out).toHaveLength(2);
    // appliesOncePerCustomer=true sorts before false
    expect(out[0].codes).toEqual(["WELCOME10"]);
    expect(out[1].codes).toEqual(["SUMMER"]);
  });

  it("pages through hasNextPage=true until false", async () => {
    const page1: FakeDiscount[] = Array.from({ length: 50 }, (_, i) => ({
      id: `gid://shopify/DiscountCodeNode/p1_${i}`,
      title: `Code ${i}`,
      status: "ACTIVE",
      appliesOncePerCustomer: false,
      codes: [`CODE_P1_${i}`],
    }));
    const page2: FakeDiscount[] = Array.from({ length: 25 }, (_, i) => ({
      id: `gid://shopify/DiscountCodeNode/p2_${i}`,
      title: `Welcome ${i}`,
      status: "ACTIVE",
      appliesOncePerCustomer: true,
      codes: [`CODE_P2_${i}`],
    }));

    const { client, spy } = makeClient([page1, page2]);
    const out = await suggestDiscounts({
      client,
      shopId: "shop_1",
      maxResults: 100,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(out.length).toBe(75);
    // First 25 should be the appliesOncePerCustomer=true ones from page2.
    for (let i = 0; i < 25; i++) {
      expect(out[i].appliesOncePerCustomer).toBe(true);
    }
    for (let i = 25; i < 75; i++) {
      expect(out[i].appliesOncePerCustomer).toBe(false);
    }
  });

  it("sorts 'welcome' titles ahead of generic when once-per-customer is equal", async () => {
    const { client } = makeClient([
      [
        {
          id: "gid://1",
          title: "Generic code",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["GENERIC"],
        },
        {
          id: "gid://2",
          title: "Welcome back",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["WELCOMEBACK"],
        },
        {
          id: "gid://3",
          title: "First purchase",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["FIRST20"],
        },
        {
          id: "gid://4",
          title: "Intro offer",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["INTRO"],
        },
      ],
    ]);

    const out = await suggestDiscounts({ client, shopId: "shop_1" });
    expect(out.map((s) => s.codes[0])).toEqual([
      "WELCOMEBACK",
      "FIRST20",
      "INTRO",
      "GENERIC",
    ]);
  });

  it("filters out EXPIRED (archived) discounts", async () => {
    const { client } = makeClient([
      [
        {
          id: "gid://1",
          title: "Active one",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["ACTIVECODE"],
        },
        {
          id: "gid://2",
          title: "Old welcome",
          status: "EXPIRED",
          appliesOncePerCustomer: true,
          codes: ["OLDWELCOME"],
        },
        {
          id: "gid://3",
          title: "Future promo",
          status: "SCHEDULED",
          appliesOncePerCustomer: true,
          codes: ["FUTURE"],
        },
      ],
    ]);

    const out = await suggestDiscounts({ client, shopId: "shop_1" });
    const codes = out.flatMap((s) => s.codes);
    expect(codes).toContain("ACTIVECODE");
    expect(codes).toContain("FUTURE");
    expect(codes).not.toContain("OLDWELCOME");
  });

  it("filters out already-protected codes for this shop", async () => {
    findManyMock.mockResolvedValue([{ codeUpper: "WELCOME10" }]);

    const { client } = makeClient([
      [
        {
          id: "gid://1",
          title: "Welcome 10",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["WELCOME10"],
        },
        {
          id: "gid://2",
          title: "Welcome 20",
          status: "ACTIVE",
          appliesOncePerCustomer: true,
          codes: ["WELCOME20"],
        },
      ],
    ]);

    const out = await suggestDiscounts({ client, shopId: "shop_1" });
    expect(out).toHaveLength(1);
    expect(out[0].codes).toEqual(["WELCOME20"]);

    // Prisma query scoped by shopId via the protectedOffer relation.
    const findArg = findManyMock.mock.calls[0][0] as {
      where: {
        codeUpper: { in: string[] };
        protectedOffer: { shopId: string };
      };
    };
    expect(findArg.where.protectedOffer.shopId).toBe("shop_1");
    expect(findArg.where.codeUpper.in).toEqual(
      expect.arrayContaining(["WELCOME10", "WELCOME20"]),
    );
  });

  it("respects maxResults", async () => {
    const { client } = makeClient([
      Array.from({ length: 20 }, (_, i) => ({
        id: `gid://${i}`,
        title: `Code ${i}`,
        status: "ACTIVE",
        appliesOncePerCustomer: true,
        codes: [`C${i}`],
      })),
    ]);

    const out = await suggestDiscounts({
      client,
      shopId: "shop_1",
      maxResults: 5,
    });
    expect(out).toHaveLength(5);
  });

  it("throws on top-level GraphQL errors", async () => {
    const spy = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      json: async () => ({ errors: [{ message: "boom" }] }),
    }));
    const client = spy as unknown as AdminGqlClient;
    await expect(
      suggestDiscounts({ client, shopId: "shop_1" }),
    ).rejects.toThrow(/boom/);
  });

  it("skips nodes with no codes or no discount detail", async () => {
    const spy = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: {
          discountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              { node: { id: "gid://1", discount: null } },
              {
                node: {
                  id: "gid://2",
                  discount: {
                    title: "No codes",
                    status: "ACTIVE",
                    appliesOncePerCustomer: true,
                    codes: { edges: [] },
                  },
                },
              },
              {
                node: {
                  id: "gid://3",
                  discount: {
                    title: "Welcome",
                    status: "ACTIVE",
                    appliesOncePerCustomer: true,
                    codes: { edges: [{ node: { code: "WELCOME" } }] },
                  },
                },
              },
            ],
          },
        },
      }),
    }));
    const client = spy as unknown as AdminGqlClient;
    const out: DiscountSuggestion[] = await suggestDiscounts({
      client,
      shopId: "shop_1",
    });
    expect(out).toHaveLength(1);
    expect(out[0].codes).toEqual(["WELCOME"]);
  });
});
