/**
 * See: docs/admin-ui-spec.md §5 (Case B — create new app-owned discount)
 * Related: docs/system-design.md § Replace-in-place (T34 extends this module)
 */

import type { AdminGqlClient } from "./admin-graphql.server.js";
import { ShopifyUserError } from "./admin-graphql.server.js";

// -- Types ------------------------------------------------------------------

export type NewDiscountAmount =
  | { kind: "percentage"; percent: number }
  | { kind: "fixed"; amount: number };

export interface CreateNewProtectedDiscountInput {
  code: string;
  amount: NewDiscountAmount;
  appliesOncePerCustomer: boolean;
  /** ISO-8601 date (YYYY-MM-DD) or null/undefined for no expiry. */
  endsAt?: string | null;
}

export interface CreateNewProtectedDiscountResult {
  discountNodeId: string;
  code: string;
}

// -- GraphQL ----------------------------------------------------------------

const SHOPIFY_FUNCTIONS_QUERY = /* GraphQL */ `
  query PromoGuardDiscountFunction {
    shopifyFunctions(first: 25) {
      nodes {
        id
        title
        apiType
        app {
          title
        }
      }
    }
  }
`;

const DISCOUNT_CODE_APP_CREATE = /* GraphQL */ `
  mutation DiscountCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount {
        discountId
        title
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// -- Response shapes --------------------------------------------------------

interface ShopifyFunctionNode {
  id: string;
  title?: string | null;
  apiType?: string | null;
  app?: { title?: string | null } | null;
}

interface ShopifyFunctionsData {
  shopifyFunctions: { nodes: ShopifyFunctionNode[] };
}

interface DiscountCodeAppCreateData {
  discountCodeAppCreate: {
    codeAppDiscount: { discountId: string; title: string } | null;
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  };
}

interface GqlResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

interface ResponseLike {
  status?: number;
  json: () => Promise<unknown>;
}

// -- Internal: minimal client call -----------------------------------------

function isResponseLike(x: unknown): x is ResponseLike {
  return !!x && typeof (x as ResponseLike).json === "function";
}

async function runGql<TData>(
  client: AdminGqlClient,
  query: string,
  variables: Record<string, unknown>,
  op: string,
): Promise<GqlResponse<TData>> {
  const call = client as unknown as (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<unknown>;

  const raw = await call(query, { variables });
  const body = isResponseLike(raw)
    ? ((await raw.json()) as GqlResponse<TData>)
    : (raw as GqlResponse<TData>);

  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `${op}: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return body;
}

// -- Public helpers --------------------------------------------------------

let cachedFunctionId: string | null = null;

/**
 * Resolve the installed Promo Guard Discount Function ID for the current
 * authenticated session. Shopify returns every function the app has access
 * to; we pick the one with apiType starting with "discount".
 *
 * Cached in-memory — function IDs are stable per app install. A cold-start
 * after a new deploy re-resolves.
 */
export async function getDiscountFunctionId(
  client: AdminGqlClient,
): Promise<string> {
  if (cachedFunctionId) return cachedFunctionId;

  const body = await runGql<ShopifyFunctionsData>(
    client,
    SHOPIFY_FUNCTIONS_QUERY,
    {},
    "shopifyFunctions",
  );
  const nodes = body.data?.shopifyFunctions?.nodes ?? [];

  // Prefer apiType starting with "discount" over title match — api types are
  // stable strings; titles get localised.
  const match =
    nodes.find(
      (n) =>
        typeof n.apiType === "string" &&
        n.apiType.toLowerCase().startsWith("discount"),
    ) ??
    nodes.find(
      (n) =>
        typeof n.title === "string" &&
        /promo[- ]?guard/i.test(n.title),
    );

  if (!match) {
    throw new Error(
      "Promo Guard Discount Function not found on this shop. " +
        "Ensure the app is installed and the discount extension is deployed.",
    );
  }
  cachedFunctionId = match.id;
  return match.id;
}

/** Exposed for tests that need a clean cache between cases. */
export function __resetFunctionIdCacheForTests(): void {
  cachedFunctionId = null;
}

/**
 * Create an app-owned DiscountCodeApp via `discountCodeAppCreate` and return
 * the new discount node GID. Used by T33 (Case B) and extended by T34
 * (replace-in-place) with additional config copied from an existing discount.
 */
export async function createNewProtectedDiscount(
  client: AdminGqlClient,
  input: CreateNewProtectedDiscountInput,
): Promise<CreateNewProtectedDiscountResult> {
  const code = input.code.trim();
  if (!code) throw new Error("createNewProtectedDiscount: code is required");

  if (input.amount.kind === "percentage") {
    const p = input.amount.percent;
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new Error(
        "createNewProtectedDiscount: percent must be between 0 and 100",
      );
    }
  } else {
    const a = input.amount.amount;
    if (!Number.isFinite(a) || a <= 0) {
      throw new Error(
        "createNewProtectedDiscount: fixed amount must be positive",
      );
    }
  }

  const functionId = await getDiscountFunctionId(client);

  const startsAt = new Date().toISOString();
  const endsAt =
    typeof input.endsAt === "string" && input.endsAt.length > 0
      ? new Date(`${input.endsAt}T23:59:59Z`).toISOString()
      : null;

  // Metafield payload the Discount Function reads at runtime. Kept
  // intentionally small — scoring pulls from the shop-level shards; this
  // metafield only carries the per-discount amount shape.
  const configMetafield = {
    namespace: "promo-guard",
    key: "config",
    type: "json",
    value: JSON.stringify({
      amount: input.amount,
      v: 1,
    }),
  };

  const codeAppDiscount = {
    functionId,
    title: `Promo Guard — ${code}`,
    code,
    appliesOncePerCustomer: input.appliesOncePerCustomer,
    startsAt,
    endsAt,
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    metafields: [configMetafield],
  };

  const body = await runGql<DiscountCodeAppCreateData>(
    client,
    DISCOUNT_CODE_APP_CREATE,
    { codeAppDiscount },
    "discountCodeAppCreate",
  );

  const payload = body.data?.discountCodeAppCreate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyUserError(payload.userErrors);
  }
  const discountId = payload?.codeAppDiscount?.discountId;
  if (!discountId) {
    throw new Error(
      "discountCodeAppCreate: response missing codeAppDiscount.discountId",
    );
  }
  return { discountNodeId: discountId, code };
}
