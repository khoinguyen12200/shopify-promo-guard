/**
 * See: docs/admin-ui-spec.md §5 (Case B — create new app-owned discount)
 * Related: app/lib/offer-service.server.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminGqlClient } from "./admin-graphql.server.js";
import { ShopifyUserError } from "./admin-graphql.server.js";
import {
  __resetFunctionIdCacheForTests,
  createNewProtectedDiscount,
  getDiscountFunctionId,
} from "./offer-service.server.js";

type MockResponse = { status?: number; body: unknown };

function responseLike({ status = 200, body }: MockResponse) {
  return {
    status,
    headers: new Headers(),
    json: async () => body,
  };
}

function makeClient(queue: MockResponse[]): {
  client: AdminGqlClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const q = [...queue];
  const spy = vi.fn(async (...args: unknown[]) => {
    void args;
    const next = q.shift();
    if (!next) throw new Error("mock client: queue empty");
    return responseLike(next);
  });
  return { client: spy as unknown as AdminGqlClient, spy };
}

beforeEach(() => {
  __resetFunctionIdCacheForTests();
});

// -- getDiscountFunctionId --------------------------------------------------

describe("getDiscountFunctionId", () => {
  it("picks the function whose apiType starts with 'discount'", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            shopifyFunctions: {
              nodes: [
                {
                  id: "gid://shopify/ShopifyFunction/other",
                  apiType: "cart_checkout_validation",
                  title: "Some other fn",
                  app: { title: "Another app" },
                },
                {
                  id: "gid://shopify/ShopifyFunction/pg-discount",
                  apiType: "discount",
                  title: "Promo Guard Discount",
                  app: { title: "Promo Guard" },
                },
              ],
            },
          },
        },
      },
    ]);

    const id = await getDiscountFunctionId(client);
    expect(id).toBe("gid://shopify/ShopifyFunction/pg-discount");
  });

  it("caches the resolved ID across calls", async () => {
    const { client, spy } = makeClient([
      {
        body: {
          data: {
            shopifyFunctions: {
              nodes: [
                {
                  id: "gid://shopify/ShopifyFunction/pg",
                  apiType: "discount",
                  title: "Promo Guard Discount",
                  app: { title: "Promo Guard" },
                },
              ],
            },
          },
        },
      },
    ]);

    await getDiscountFunctionId(client);
    await getDiscountFunctionId(client);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to title match when apiType is missing", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            shopifyFunctions: {
              nodes: [
                {
                  id: "gid://shopify/ShopifyFunction/pg",
                  title: "Promo Guard Discount",
                  app: { title: "Promo Guard" },
                },
              ],
            },
          },
        },
      },
    ]);

    const id = await getDiscountFunctionId(client);
    expect(id).toBe("gid://shopify/ShopifyFunction/pg");
  });

  it("throws when no matching function exists", async () => {
    const { client } = makeClient([
      { body: { data: { shopifyFunctions: { nodes: [] } } } },
    ]);
    await expect(getDiscountFunctionId(client)).rejects.toThrow(
      /not found/i,
    );
  });
});

// -- createNewProtectedDiscount --------------------------------------------

describe("createNewProtectedDiscount", () => {
  const functionsResponse: MockResponse = {
    body: {
      data: {
        shopifyFunctions: {
          nodes: [
            {
              id: "gid://shopify/ShopifyFunction/pg",
              apiType: "discount",
              title: "Promo Guard Discount",
              app: { title: "Promo Guard" },
            },
          ],
        },
      },
    },
  };

  it("creates a percentage discount and returns discountNodeId", async () => {
    const { client, spy } = makeClient([
      functionsResponse,
      {
        body: {
          data: {
            discountCodeAppCreate: {
              codeAppDiscount: {
                discountId: "gid://shopify/DiscountNode/999",
                title: "Promo Guard — WELCOMEBACK",
              },
              userErrors: [],
            },
          },
        },
      },
    ]);

    const result = await createNewProtectedDiscount(client, {
      code: "WELCOMEBACK",
      amount: { kind: "percentage", percent: 10 },
      appliesOncePerCustomer: true,
    });

    expect(result).toEqual({
      discountNodeId: "gid://shopify/DiscountNode/999",
      code: "WELCOMEBACK",
    });

    // Verify the mutation got the right input shape.
    const createCall = spy.mock.calls[1]!;
    const variables = (createCall[1] as { variables: Record<string, unknown> })
      .variables;
    const payload = variables.codeAppDiscount as Record<string, unknown>;
    expect(payload.functionId).toBe("gid://shopify/ShopifyFunction/pg");
    expect(payload.code).toBe("WELCOMEBACK");
    expect(payload.appliesOncePerCustomer).toBe(true);
    expect(payload.title).toBe("Promo Guard — WELCOMEBACK");
    expect(payload.endsAt).toBeNull();
    expect(
      (payload.metafields as Array<Record<string, unknown>>)[0]?.key,
    ).toBe("config");
  });

  it("passes an ISO endsAt when the caller supplies a date", async () => {
    const { client, spy } = makeClient([
      functionsResponse,
      {
        body: {
          data: {
            discountCodeAppCreate: {
              codeAppDiscount: {
                discountId: "gid://shopify/DiscountNode/1",
                title: "x",
              },
              userErrors: [],
            },
          },
        },
      },
    ]);

    await createNewProtectedDiscount(client, {
      code: "NEWBIE",
      amount: { kind: "fixed", amount: 5 },
      appliesOncePerCustomer: true,
      endsAt: "2026-12-31",
    });

    const payload = (
      spy.mock.calls[1]![1] as { variables: Record<string, unknown> }
    ).variables.codeAppDiscount as Record<string, unknown>;
    expect(payload.endsAt).toMatch(/^2026-12-31T/);
  });

  it("rejects invalid percentage amounts before touching Shopify", async () => {
    const { client, spy } = makeClient([functionsResponse]);
    await expect(
      createNewProtectedDiscount(client, {
        code: "BAD",
        amount: { kind: "percentage", percent: 0 },
        appliesOncePerCustomer: true,
      }),
    ).rejects.toThrow(/percent/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces userErrors as ShopifyUserError", async () => {
    const { client } = makeClient([
      functionsResponse,
      {
        body: {
          data: {
            discountCodeAppCreate: {
              codeAppDiscount: null,
              userErrors: [
                { field: ["code"], message: "Code must be unique" },
              ],
            },
          },
        },
      },
    ]);

    await expect(
      createNewProtectedDiscount(client, {
        code: "DUPLICATE",
        amount: { kind: "percentage", percent: 10 },
        appliesOncePerCustomer: true,
      }),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });
});
