/**
 * See: docs/admin-ui-spec.md §5 (Case B — create new app-owned discount)
 * Related: app/lib/offer-service.server.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateManyMock = vi.fn(
  async (args: unknown): Promise<{ count: number }> => {
    void args;
    return { count: 1 };
  },
);
const findFirstMock = vi.fn(async (args: unknown): Promise<unknown> => {
  void args;
  return null;
});
const updateMock = vi.fn(async (args: unknown): Promise<unknown> => {
  void args;
  return {};
});
const codeUpdateManyMock = vi.fn(
  async (args: unknown): Promise<{ count: number }> => {
    void args;
    return { count: 1 };
  },
);
const transactionMock = vi.fn(async (ops: Promise<unknown>[]) => {
  return Promise.all(ops);
});

vi.mock("../db.server.js", () => ({
  default: {
    protectedOffer: {
      updateMany: (args: unknown) => updateManyMock(args),
      findFirst: (args: unknown) => findFirstMock(args),
      update: (args: unknown) => updateMock(args),
    },
    protectedCode: {
      updateMany: (args: unknown) => codeUpdateManyMock(args),
    },
    $transaction: (ops: Promise<unknown>[]) => transactionMock(ops),
  },
}));

import type { AdminGqlClient } from "./admin-graphql.server.js";
import { ShopifyUserError } from "./admin-graphql.server.js";
import {
  __resetFunctionIdCacheForTests,
  createNewProtectedDiscount,
  deleteOffer,
  discountCodeDeactivate,
  getDiscountFunctionId,
  readNativeDiscountByCode,
  replaceInPlace,
  setOfferStatus,
  updateOfferFields,
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
  updateManyMock.mockClear();
  updateManyMock.mockImplementation(async () => ({ count: 1 }));
  findFirstMock.mockClear();
  findFirstMock.mockImplementation(async () => null);
  updateMock.mockClear();
  updateMock.mockImplementation(async () => ({}));
  codeUpdateManyMock.mockClear();
  codeUpdateManyMock.mockImplementation(async () => ({ count: 1 }));
  transactionMock.mockClear();
  transactionMock.mockImplementation(async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
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

// -- readNativeDiscountByCode ----------------------------------------------

describe("readNativeDiscountByCode", () => {
  it("parses a percentage DiscountCodeBasic (0-1 decimal form)", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            codeDiscountNodeByCode: {
              id: "gid://shopify/DiscountNode/old",
              codeDiscount: {
                title: "WELCOME10",
                startsAt: "2026-01-01T00:00:00Z",
                endsAt: "2026-12-31T23:59:59Z",
                usageLimit: null,
                appliesOncePerCustomer: true,
                customerGets: { value: { percentage: 0.1 } },
              },
            },
          },
        },
      },
    ]);

    const result = await readNativeDiscountByCode(client, "WELCOME10");
    expect(result).toEqual({
      discountNodeId: "gid://shopify/DiscountNode/old",
      amount: { kind: "percentage", percent: 10 },
      appliesOncePerCustomer: true,
      endsAt: "2026-12-31T23:59:59Z",
    });
  });

  it("parses a fixed-amount DiscountCodeBasic", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            codeDiscountNodeByCode: {
              id: "gid://shopify/DiscountNode/fixed",
              codeDiscount: {
                title: "NEWBIE5",
                startsAt: null,
                endsAt: null,
                appliesOncePerCustomer: false,
                customerGets: {
                  value: { amount: { amount: "5.00" } },
                },
              },
            },
          },
        },
      },
    ]);

    const result = await readNativeDiscountByCode(client, "NEWBIE5");
    expect(result?.amount).toEqual({ kind: "fixed", amount: 5 });
    expect(result?.appliesOncePerCustomer).toBe(false);
    expect(result?.endsAt).toBeNull();
  });

  it("returns null when the code is not found", async () => {
    const { client } = makeClient([
      { body: { data: { codeDiscountNodeByCode: null } } },
    ]);
    expect(await readNativeDiscountByCode(client, "NOPE")).toBeNull();
  });
});

// -- discountCodeDeactivate -------------------------------------------------

describe("discountCodeDeactivate", () => {
  it("throws ShopifyUserError when userErrors are returned", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: null,
              userErrors: [
                { field: ["id"], message: "Discount not found" },
              ],
            },
          },
        },
      },
    ]);
    await expect(
      discountCodeDeactivate(client, "gid://shopify/DiscountNode/bad"),
    ).rejects.toBeInstanceOf(ShopifyUserError);
  });

  it("resolves silently on success", async () => {
    const { client } = makeClient([
      {
        body: {
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: { id: "gid://shopify/DiscountNode/ok" },
              userErrors: [],
            },
          },
        },
      },
    ]);
    await expect(
      discountCodeDeactivate(client, "gid://shopify/DiscountNode/ok"),
    ).resolves.toBeUndefined();
  });
});

// -- replaceInPlace ---------------------------------------------------------

describe("replaceInPlace", () => {
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

  it("deactivates BEFORE creating — ordering is load-bearing", async () => {
    const callOrder: string[] = [];
    const spy = vi.fn(async (query: string) => {
      if (query.includes("codeDiscountNodeByCode")) {
        callOrder.push("read");
        return responseLike({
          body: {
            data: {
              codeDiscountNodeByCode: {
                id: "gid://shopify/DiscountNode/old",
                codeDiscount: {
                  appliesOncePerCustomer: true,
                  customerGets: { value: { percentage: 0.1 } },
                  endsAt: null,
                },
              },
            },
          },
        });
      }
      if (query.includes("discountCodeDeactivate")) {
        callOrder.push("deactivate");
        return responseLike({
          body: {
            data: {
              discountCodeDeactivate: {
                codeDiscountNode: { id: "gid://shopify/DiscountNode/old" },
                userErrors: [],
              },
            },
          },
        });
      }
      if (query.includes("shopifyFunctions")) {
        callOrder.push("functions");
        return responseLike(functionsResponse);
      }
      if (query.includes("discountCodeAppCreate")) {
        callOrder.push("create");
        return responseLike({
          body: {
            data: {
              discountCodeAppCreate: {
                codeAppDiscount: {
                  discountId: "gid://shopify/DiscountNode/new",
                  title: "Promo Guard — WELCOME10",
                },
                userErrors: [],
              },
            },
          },
        });
      }
      throw new Error(`unexpected query: ${query}`);
    });
    const client = spy as unknown as AdminGqlClient;

    const result = await replaceInPlace(client, { code: "WELCOME10" });

    expect(result).toEqual({
      discountNodeId: "gid://shopify/DiscountNode/new",
      replacedDiscountNodeId: "gid://shopify/DiscountNode/old",
      code: "WELCOME10",
    });

    // Deactivate must come BEFORE create. Function-id lookup can happen
    // either before or after deactivate, but create must be last.
    const deactivateIdx = callOrder.indexOf("deactivate");
    const createIdx = callOrder.indexOf("create");
    expect(deactivateIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(deactivateIdx);
  });

  it("throws when the existing code cannot be resolved", async () => {
    const { client } = makeClient([
      { body: { data: { codeDiscountNodeByCode: null } } },
    ]);
    await expect(replaceInPlace(client, { code: "MISSING" })).rejects.toThrow(
      /could not resolve/i,
    );
  });
});

// -- Status transitions (T36) ----------------------------------------------

describe("setOfferStatus", () => {
  it("scopes the update by offerId + shopId + archivedAt", async () => {
    await setOfferStatus({
      offerId: "offer-1",
      shopId: "shop-1",
      status: "paused",
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "offer-1",
        shopId: "shop-1",
        archivedAt: null,
      },
      data: { status: "paused" },
    });
  });

  it("throws when no row matches (cross-shop attempt / archived)", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(
      setOfferStatus({
        offerId: "offer-1",
        shopId: "other-shop",
        status: "active",
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

// -- deleteOffer (T37) -----------------------------------------------------

describe("deleteOffer", () => {
  function loadOffer(codes: unknown[]) {
    findFirstMock.mockImplementationOnce(async () => ({
      id: "offer-1",
      shopId: "shop-1",
      codes,
    }));
  }

  it("restore path: deletes replacement BEFORE renaming+activating the original with the clean code", async () => {
    loadOffer([
      {
        id: "code-1",
        code: "WELCOME10",
        codeUpper: "WELCOME10",
        discountNodeId: "gid://shopify/DiscountNode/new",
        isAppOwned: true,
        replacedDiscountNodeId: "gid://shopify/DiscountNode/old",
      },
    ]);

    const order: string[] = [];
    let renameVars: Record<string, unknown> | null = null;
    const client = vi.fn(
      async (query: string, opts?: { variables: Record<string, unknown> }) => {
        if (query.includes("DiscountCodeDelete")) order.push("delete");
        if (query.includes("DiscountCodeRenameAndActivate")) {
          order.push("rename+activate");
          renameVars = opts?.variables ?? null;
        }
        return {
          status: 200,
          headers: new Headers(),
          json: async () =>
            query.includes("DiscountCodeDelete")
              ? {
                  data: {
                    discountCodeDelete: {
                      deletedCodeDiscountId:
                        "gid://shopify/DiscountNode/new",
                      userErrors: [],
                    },
                  },
                }
              : {
                  data: {
                    discountCodeBasicUpdate: {
                      codeDiscountNode: { id: "old" },
                      userErrors: [],
                    },
                    discountCodeActivate: {
                      codeDiscountNode: { id: "old" },
                      userErrors: [],
                    },
                  },
                },
        };
      },
    ) as unknown as AdminGqlClient;

    const result = await deleteOffer(client, {
      offerId: "offer-1",
      shopId: "shop-1",
      restoreReplaced: true,
    });

    expect(result.restoredDiscountNodeIds).toEqual([
      "gid://shopify/DiscountNode/old",
    ]);
    expect(order).toEqual(["delete", "rename+activate"]);
    // Rename must target the pre-protection clean code, not the archive name.
    expect(renameVars).toMatchObject({
      id: "gid://shopify/DiscountNode/old",
      basicCodeDiscount: { code: "WELCOME10" },
    });
    // Soft-delete happened: codes archived + offer archived in a transaction.
    expect(codeUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("delete path: deletes the app-owned clone, does NOT touch the replaced original", async () => {
    loadOffer([
      {
        id: "code-1",
        code: "WELCOME10",
        codeUpper: "WELCOME10",
        discountNodeId: "gid://shopify/DiscountNode/new",
        isAppOwned: true,
        replacedDiscountNodeId: "gid://shopify/DiscountNode/old",
      },
    ]);

    const order: string[] = [];
    const client = vi.fn(async (query: string) => {
      if (query.includes("DiscountCodeDelete")) order.push("delete");
      if (query.includes("DiscountCodeRenameAndActivate"))
        order.push("rename+activate");
      return {
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: {
            discountCodeDelete: {
              deletedCodeDiscountId: "gid://shopify/DiscountNode/new",
              userErrors: [],
            },
          },
        }),
      };
    }) as unknown as AdminGqlClient;

    const result = await deleteOffer(client, {
      offerId: "offer-1",
      shopId: "shop-1",
      restoreReplaced: false,
    });

    expect(result.restoredDiscountNodeIds).toEqual([]);
    expect(order).toEqual(["delete"]);
  });

  it("throws when the offer doesn't exist for this shop", async () => {
    findFirstMock.mockImplementationOnce(async () => null);
    const client = vi.fn() as unknown as AdminGqlClient;
    await expect(
      deleteOffer(client, {
        offerId: "missing",
        shopId: "shop-1",
        restoreReplaced: false,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
