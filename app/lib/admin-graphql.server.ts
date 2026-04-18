/**
 * See: docs/webhook-spec.md §9 (Admin GraphQL helpers)
 * Related: docs/function-queries-spec.md § Verified Shopify schema facts
 *
 * Thin wrappers around Shopify Admin GraphQL mutations we call from webhook
 * handlers: orderRiskAssessmentCreate, tagsAdd, metafieldsSet. Each helper:
 *   - accepts an injected `admin.graphql` client (from `authenticate.webhook`
 *     / `authenticate.admin`) so we never instantiate our own HTTP client
 *   - handles 429 (throttled) with fixed exponential backoff, up to 3 retries
 *   - surfaces GraphQL `userErrors[]` as a typed ShopifyUserError
 *   - fails fast on 5xx (at most one retry)
 *   - logs the Shopify `extensions.cost` object at debug level
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type AdminGqlClient = AdminApiContext["graphql"];

// -- Errors -----------------------------------------------------------------

export class ShopifyUserError extends Error {
  constructor(
    readonly errors: Array<{ field?: string[] | null; message: string }>,
  ) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "ShopifyUserError";
  }
}

export class ShopifyThrottledError extends Error {
  constructor(message = "Shopify Admin GraphQL throttled after retries") {
    super(message);
    this.name = "ShopifyThrottledError";
  }
}

// -- Internal: retry/backoff -------------------------------------------------

const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 10_000;
const METAFIELDS_BATCH_SIZE = 25;

type GqlExtensions = {
  cost?: {
    requestedQueryCost?: number;
    actualQueryCost?: number;
    throttleStatus?: {
      maximumAvailable?: number;
      currentlyAvailable?: number;
      restoreRate?: number;
    };
  };
};

type GqlResponse<TData> = {
  data?: TData;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: GqlExtensions;
};

type ResponseLike = {
  status?: number;
  headers?: Headers | { get?: (k: string) => string | null | undefined };
  json: () => Promise<unknown>;
};

function isResponseLike(x: unknown): x is ResponseLike {
  return !!x && typeof (x as ResponseLike).json === "function";
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logCost(op: string, extensions: GqlExtensions | undefined): void {
  if (!extensions?.cost) return;
  // Keep this at debug level; tests don't assert on it.
  if (typeof process !== "undefined" && process.env?.DEBUG_GQL === "1") {
    // eslint-disable-next-line no-console
    console.debug(`[admin-graphql] ${op} cost`, extensions.cost);
  }
}

function isThrottled(status: number | undefined, body: unknown): boolean {
  if (status === 429) return true;
  if (body && typeof body === "object") {
    const errs = (body as GqlResponse<unknown>).errors;
    if (Array.isArray(errs)) {
      for (const e of errs) {
        if (e?.extensions?.code === "THROTTLED") return true;
        if (typeof e?.message === "string" && /throttled/i.test(e.message)) {
          return true;
        }
      }
    }
  }
  return false;
}

function isServerError(status: number | undefined): boolean {
  return typeof status === "number" && status >= 500 && status < 600;
}

/**
 * Execute a single Admin GraphQL mutation with retry/backoff.
 * The `client` signature matches `admin.graphql` from shopify-app-react-router:
 *   (query: string, options?: { variables: ... }) => Promise<ResponseLike>
 * where ResponseLike has `.status`, `.headers`, `.json()`.
 *
 * We accept `any` for the client here because the upstream type is a generic
 * keyed by strongly-typed operations, and our hand-written mutation strings
 * are not in that operation registry.
 */
async function runMutation<TData>(
  client: AdminGqlClient,
  query: string,
  variables: Record<string, unknown>,
  op: string,
): Promise<GqlResponse<TData>> {
  const call = client as unknown as (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<ResponseLike>;

  let serverRetriesRemaining = 1; // 5xx: one retry then fail fast
  let throttleAttempts = 0; // 429/THROTTLED: up to MAX_RETRIES

  // Loop until we either return or throw.
  // Using a bounded outer counter as a safety net.
  for (let guard = 0; guard < MAX_RETRIES + 3; guard++) {
    let body: GqlResponse<TData> | undefined;
    let status: number | undefined;
    let thrown: unknown;

    try {
      const raw = await call(query, { variables });
      if (isResponseLike(raw)) {
        status = raw.status;
        body = (await raw.json()) as GqlResponse<TData>;
      } else {
        // Some mocks may return the body directly.
        body = raw as unknown as GqlResponse<TData>;
      }
    } catch (err) {
      thrown = err;
    }

    // Detect throttling either via HTTP 429 or errors[].extensions.code
    if (!thrown && isThrottled(status, body)) {
      if (throttleAttempts >= MAX_RETRIES) {
        throw new ShopifyThrottledError();
      }
      await sleep(backoffMs(throttleAttempts));
      throttleAttempts++;
      continue;
    }

    // 5xx: fail fast after one retry
    if (!thrown && isServerError(status)) {
      if (serverRetriesRemaining > 0) {
        serverRetriesRemaining--;
        await sleep(backoffMs(0));
        continue;
      }
      throw new Error(
        `Shopify Admin GraphQL ${op} failed with HTTP ${status}`,
      );
    }

    if (thrown) {
      // Treat thrown errors as non-retryable unless they look like throttling
      const msg = (thrown as Error)?.message ?? String(thrown);
      if (/throttled/i.test(msg) || /429/.test(msg)) {
        if (throttleAttempts >= MAX_RETRIES) {
          throw new ShopifyThrottledError();
        }
        await sleep(backoffMs(throttleAttempts));
        throttleAttempts++;
        continue;
      }
      throw thrown instanceof Error ? thrown : new Error(msg);
    }

    // At this point we have a body we trust
    if (body?.errors && body.errors.length > 0) {
      // Top-level GraphQL errors (not userErrors) → throw as generic Error
      throw new Error(
        `Shopify Admin GraphQL ${op} errored: ${body.errors
          .map((e) => e.message)
          .join("; ")}`,
      );
    }

    logCost(op, body?.extensions);
    return body ?? {};
  }

  // Fell through the guard — treat as throttled exhaustion.
  throw new ShopifyThrottledError();
}

function assertNoUserErrors(
  userErrors: Array<{ field?: string[] | null; message: string }> | undefined,
): void {
  if (userErrors && userErrors.length > 0) {
    throw new ShopifyUserError(userErrors);
  }
}

// -- GraphQL mutations (hand-written string literals) -----------------------

const ORDER_RISK_ASSESSMENT_CREATE = /* GraphQL */ `
  mutation OrderRiskAssessmentCreate(
    $orderId: ID!
    $riskLevel: OrderRiskAssessmentRiskLevel!
    $facts: [OrderRiskAssessmentFactInput!]!
    $source: String
  ) {
    orderRiskAssessmentCreate(
      orderId: $orderId
      riskAssessment: { riskLevel: $riskLevel, facts: $facts, source: $source }
    ) {
      orderRiskAssessment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD = /* GraphQL */ `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
        ... on Customer {
          tags
        }
        ... on Order {
          tags
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELDS_SET = /* GraphQL */ `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// -- Typed response shapes --------------------------------------------------

type OrderRiskAssessmentCreateData = {
  orderRiskAssessmentCreate: {
    orderRiskAssessment: { id: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};

type TagsAddData = {
  tagsAdd: {
    node: { id: string; tags?: string[] } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};

type MetafieldsSetData = {
  metafieldsSet: {
    metafields: Array<{ id: string; key: string; namespace: string }> | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};

// -- Public helpers ---------------------------------------------------------

export async function orderRiskAssessmentCreate(
  client: AdminGqlClient,
  input: {
    orderId: string;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    facts: Array<{
      description: string;
      sentiment: "NEUTRAL" | "NEGATIVE" | "POSITIVE";
    }>;
    source?: string;
  },
): Promise<{ riskAssessmentId: string }> {
  const body = await runMutation<OrderRiskAssessmentCreateData>(
    client,
    ORDER_RISK_ASSESSMENT_CREATE,
    {
      orderId: input.orderId,
      riskLevel: input.riskLevel,
      facts: input.facts,
      source: input.source ?? "Promo Guard",
    },
    "orderRiskAssessmentCreate",
  );
  const payload = body.data?.orderRiskAssessmentCreate;
  assertNoUserErrors(payload?.userErrors);
  const id = payload?.orderRiskAssessment?.id;
  if (!id) {
    throw new Error(
      "orderRiskAssessmentCreate: missing orderRiskAssessment.id in response",
    );
  }
  return { riskAssessmentId: id };
}

export async function tagsAdd(
  client: AdminGqlClient,
  resourceId: string,
  tags: string[],
): Promise<{ node: { id: string; tags: string[] } }> {
  const body = await runMutation<TagsAddData>(
    client,
    TAGS_ADD,
    { id: resourceId, tags },
    "tagsAdd",
  );
  const payload = body.data?.tagsAdd;
  assertNoUserErrors(payload?.userErrors);
  const node = payload?.node;
  if (!node?.id) {
    throw new Error("tagsAdd: missing node.id in response");
  }
  return { node: { id: node.id, tags: node.tags ?? [] } };
}

export async function metafieldsSet(
  client: AdminGqlClient,
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
): Promise<Array<{ id: string; key: string }>> {
  const out: Array<{ id: string; key: string }> = [];

  // Shopify's metafieldsSet accepts up to 25 metafields per call.
  // Split here so callers don't have to.
  for (let i = 0; i < metafields.length; i += METAFIELDS_BATCH_SIZE) {
    const chunk = metafields.slice(i, i + METAFIELDS_BATCH_SIZE);
    const body = await runMutation<MetafieldsSetData>(
      client,
      METAFIELDS_SET,
      { metafields: chunk },
      "metafieldsSet",
    );
    const payload = body.data?.metafieldsSet;
    assertNoUserErrors(payload?.userErrors);
    const returned = payload?.metafields ?? [];
    for (const m of returned) {
      out.push({ id: m.id, key: m.key });
    }
  }

  return out;
}
