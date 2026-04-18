/**
 * See: docs/webhook-spec.md §9 (Admin GraphQL helpers)
 * Related: app/lib/admin-graphql.server.ts
 */

import { describe, expect, it, vi } from "vitest";

import {
  ShopifyThrottledError,
  ShopifyUserError,
  metafieldsSet,
  orderRiskAssessmentCreate,
  tagsAdd,
  tagsRemove,
  type AdminGqlClient,
} from "./admin-graphql.server.js";

// -- Test helpers -----------------------------------------------------------

type MockResponse = {
  status?: number;
  body: unknown;
};

/**
 * Build a Response-like object that matches what `admin.graphql` returns:
 * an object with `.status`, `.headers`, and `.json()`.
 */
function responseLike({ status = 200, body }: MockResponse) {
  return {
    status,
    headers: new Headers(),
    json: async () => body,
  };
}

/**
 * Make a mock client. `responses` is a queue — each call pops the next one.
 * The returned object exposes the vitest spy so tests can assert call count
 * and inspect the query / variables that were passed in.
 */
function makeClient(responses: MockResponse[]): {
  client: AdminGqlClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const spy = vi.fn(async (...args: unknown[]) => {
    void args;
    const next = queue.shift();
    if (!next) {
      throw new Error("mock client: no more queued responses");
    }
    return responseLike(next);
  });
  // Cast to AdminGqlClient — the upstream type is generic over typed operations,
  // but the runtime shape (query string, opts) is all we actually use.
  return { client: spy as unknown as AdminGqlClient, spy };
}

// -- orderRiskAssessmentCreate ----------------------------------------------

describe("orderRiskAssessmentCreate", () => {
  it("returns riskAssessmentId on happy path", async () => {
    const { client, spy } = makeClient([
      {
        body: {
          data: {
            orderRiskAssessmentCreate: {
              orderRiskAssessment: {
                id: "gid://shopify/OrderRiskAssessment/1",
              },
              userErrors: [],
            },
          },
        },
      },
    ]);

    const result = await orderRiskAssessmentCreate(client, {
      orderId: "gid://shopify/Order/42",
      riskLevel: "HIGH",
      facts: [{ description: "Repeat buyer", sentiment: "NEGATIVE" }],
    });

    expect(result).toEqual({
      riskAssessmentId: "gid://shopify/OrderRiskAssessment/1",
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // Verify default source was applied and variables were passed through.
    const [, opts] = spy.mock.calls[0];
    expect((opts as { variables: Record<string, unknown> }).variables).toEqual({
      orderId: "gid://shopify/Order/42",
      riskLevel: "HIGH",
      facts: [{ description: "Repeat buyer", sentiment: "NEGATIVE" }],
      source: "Promo Guard",
    });
  });

  it("throws ShopifyUserError when userErrors are returned", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            orderRiskAssessmentCreate: {
              orderRiskAssessment: null,
              userErrors: [
                { field: ["orderId"], message: "Order not found" },
              ],
            },
          },
        },
      },
    ]);

    await expect(
      orderRiskAssessmentCreate(client, {
        orderId: "gid://shopify/Order/404",
        riskLevel: "LOW",
        facts: [],
      }),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });

  it("retries once on 429 then succeeds", async () => {
    const { client, spy } = makeClient([
      {
        status: 429,
        body: {
          errors: [
            {
              message: "Throttled",
              extensions: { code: "THROTTLED" },
            },
          ],
        },
      },
      {
        body: {
          data: {
            orderRiskAssessmentCreate: {
              orderRiskAssessment: {
                id: "gid://shopify/OrderRiskAssessment/2",
              },
              userErrors: [],
            },
          },
        },
      },
    ]);

    // Make the backoff instant so the test doesn't wait seconds.
    vi.useFakeTimers();
    const promise = orderRiskAssessmentCreate(client, {
      orderId: "gid://shopify/Order/1",
      riskLevel: "MEDIUM",
      facts: [],
    });
    // Advance through any backoff sleeps.
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.riskAssessmentId).toBe(
      "gid://shopify/OrderRiskAssessment/2",
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws ShopifyThrottledError after 3 consecutive 429s", async () => {
    const throttled: MockResponse = {
      status: 429,
      body: {
        errors: [
          { message: "Throttled", extensions: { code: "THROTTLED" } },
        ],
      },
    };
    const { client, spy } = makeClient([throttled, throttled, throttled, throttled]);

    vi.useFakeTimers();
    const promise = orderRiskAssessmentCreate(client, {
      orderId: "gid://shopify/Order/1",
      riskLevel: "LOW",
      facts: [],
    }).catch((err) => err);
    await vi.runAllTimersAsync();
    const settled = await promise;
    vi.useRealTimers();

    expect(settled).toBeInstanceOf(ShopifyThrottledError);
    // Initial try + 3 retry attempts = at most 4 calls before giving up.
    // Our implementation throws on the 4th throttle observation.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// -- tagsAdd ---------------------------------------------------------------

describe("tagsAdd", () => {
  it("returns node.id + tags on happy path", async () => {
    const { client, spy } = makeClient([
      {
        body: {
          data: {
            tagsAdd: {
              node: {
                id: "gid://shopify/Order/42",
                tags: ["promo-guard-flagged"],
              },
              userErrors: [],
            },
          },
        },
      },
    ]);

    const result = await tagsAdd(
      client,
      "gid://shopify/Order/42",
      ["promo-guard-flagged"],
    );

    expect(result).toEqual({
      node: { id: "gid://shopify/Order/42", tags: ["promo-guard-flagged"] },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws ShopifyUserError when userErrors are returned", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            tagsAdd: {
              node: null,
              userErrors: [{ field: ["id"], message: "Invalid id" }],
            },
          },
        },
      },
    ]);

    await expect(
      tagsAdd(client, "gid://shopify/Order/404", ["x"]),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });
});

// -- tagsRemove ------------------------------------------------------------

describe("tagsRemove", () => {
  it("returns node.id + tags on happy path", async () => {
    const { client, spy } = makeClient([
      {
        body: {
          data: {
            tagsRemove: {
              node: {
                id: "gid://shopify/Customer/42",
                tags: [],
              },
              userErrors: [],
            },
          },
        },
      },
    ]);

    const result = await tagsRemove(
      client,
      "gid://shopify/Customer/42",
      ["promo-guard-flag"],
    );

    expect(result).toEqual({
      node: { id: "gid://shopify/Customer/42", tags: [] },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws ShopifyUserError when userErrors are returned", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            tagsRemove: {
              node: null,
              userErrors: [{ field: ["id"], message: "Invalid id" }],
            },
          },
        },
      },
    ]);

    await expect(
      tagsRemove(client, "gid://shopify/Customer/404", ["x"]),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });
});

// -- metafieldsSet ---------------------------------------------------------

describe("metafieldsSet", () => {
  it("makes a single call for 5 metafields (batching works for small sets)", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      ownerId: "gid://shopify/Shop/1",
      namespace: "$app",
      key: `k${i}`,
      type: "json",
      value: "[]",
    }));

    const { client, spy } = makeClient([
      {
        body: {
          data: {
            metafieldsSet: {
              metafields: five.map((m, i) => ({
                id: `gid://shopify/Metafield/${i}`,
                key: m.key,
                namespace: m.namespace,
              })),
              userErrors: [],
            },
          },
        },
      },
    ]);

    const result = await metafieldsSet(client, five);

    expect(spy).toHaveBeenCalledTimes(1);
    // The 5 keys were passed in a single mutation call.
    const [, opts] = spy.mock.calls[0];
    const vars = (opts as { variables: { metafields: unknown[] } }).variables;
    expect(vars.metafields).toHaveLength(5);
    expect(result).toHaveLength(5);
    expect(result.map((m) => m.key)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });

  it("splits 27 metafields into two calls (25 + 2)", async () => {
    const twentySeven = Array.from({ length: 27 }, (_, i) => ({
      ownerId: "gid://shopify/Shop/1",
      namespace: "$app",
      key: `k${i}`,
      type: "json",
      value: "[]",
    }));

    const { client, spy } = makeClient([
      {
        body: {
          data: {
            metafieldsSet: {
              metafields: twentySeven.slice(0, 25).map((m, i) => ({
                id: `gid://shopify/Metafield/${i}`,
                key: m.key,
                namespace: m.namespace,
              })),
              userErrors: [],
            },
          },
        },
      },
      {
        body: {
          data: {
            metafieldsSet: {
              metafields: twentySeven.slice(25).map((m, i) => ({
                id: `gid://shopify/Metafield/${25 + i}`,
                key: m.key,
                namespace: m.namespace,
              })),
              userErrors: [],
            },
          },
        },
      },
    ]);

    const result = await metafieldsSet(client, twentySeven);

    expect(spy).toHaveBeenCalledTimes(2);
    const firstVars = (
      spy.mock.calls[0][1] as { variables: { metafields: unknown[] } }
    ).variables;
    const secondVars = (
      spy.mock.calls[1][1] as { variables: { metafields: unknown[] } }
    ).variables;
    expect(firstVars.metafields).toHaveLength(25);
    expect(secondVars.metafields).toHaveLength(2);
    expect(result).toHaveLength(27);
  });

  it("throws ShopifyUserError when userErrors are returned", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [
                { field: ["metafields", "0", "value"], message: "Invalid" },
              ],
            },
          },
        },
      },
    ]);

    await expect(
      metafieldsSet(client, [
        {
          ownerId: "gid://shopify/Shop/1",
          namespace: "$app",
          key: "k",
          type: "json",
          value: "not-json",
        },
      ]),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });
});
