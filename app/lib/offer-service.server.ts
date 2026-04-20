/**
 * See: docs/admin-ui-spec.md §5 (Case B — create new app-owned discount)
 * Related: docs/system-design.md § Replace-in-place (T34)
 */

import prisma from "../db.server.js";
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
    discountClasses: ["ORDER", "PRODUCT"],
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

// -- Replace-in-place (T34) ------------------------------------------------

const CODE_DISCOUNT_NODE_BY_CODE = /* GraphQL */ `
  query CodeDiscountNodeByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          startsAt
          endsAt
          usageLimit
          appliesOncePerCustomer
          customerGets {
            value {
              ... on DiscountPercentage {
                percentage
              }
              ... on DiscountAmount {
                amount {
                  amount
                }
              }
            }
          }
        }
      }
    }
  }
`;

const DISCOUNT_CODE_RENAME_AND_DEACTIVATE = /* GraphQL */ `
  mutation DiscountCodeRenameAndDeactivate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
    discountCodeDeactivate(id: $id) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DISCOUNT_CODE_DEACTIVATE = /* GraphQL */ `
  mutation DiscountCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DISCOUNT_CODE_DELETE = /* GraphQL */ `
  mutation DiscountCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DISCOUNT_CODE_RENAME_AND_ACTIVATE = /* GraphQL */ `
  mutation DiscountCodeRenameAndActivate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
    discountCodeActivate(id: $id) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface CodeDiscountNodeByCodeData {
  codeDiscountNodeByCode: {
    id: string;
    codeDiscount?: {
      title?: string | null;
      startsAt?: string | null;
      endsAt?: string | null;
      usageLimit?: number | null;
      appliesOncePerCustomer?: boolean | null;
      customerGets?: {
        value?: {
          percentage?: number | null;
          amount?: { amount?: string | null } | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface DiscountCodeRenameAndDeactivateData {
  discountCodeBasicUpdate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
  };
  discountCodeDeactivate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
  };
}

interface DiscountCodeDeactivateData {
  discountCodeDeactivate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  };
}

interface DiscountCodeDeleteData {
  discountCodeDelete: {
    deletedCodeDiscountId: string | null;
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  };
}

interface DiscountCodeRenameAndActivateData {
  discountCodeBasicUpdate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  };
  discountCodeActivate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  };
}

export interface ResolvedNativeDiscount {
  discountNodeId: string;
  amount: NewDiscountAmount;
  appliesOncePerCustomer: boolean;
  endsAt: string | null;
}

/**
 * Read an existing native discount by its code string. Returns the fields
 * we copy into the replacement app-owned discount. Supports DiscountCodeBasic
 * only for MVP — Bxgy / FreeShipping codes cannot silent-strip.
 */
export async function readNativeDiscountByCode(
  client: AdminGqlClient,
  code: string,
): Promise<ResolvedNativeDiscount | null> {
  const body = await runGql<CodeDiscountNodeByCodeData>(
    client,
    CODE_DISCOUNT_NODE_BY_CODE,
    { code },
    "codeDiscountNodeByCode",
  );
  const node = body.data?.codeDiscountNodeByCode;
  if (!node?.id) return null;
  const detail = node.codeDiscount;
  if (!detail) return null;

  const percentRaw = detail.customerGets?.value?.percentage;
  const amountRaw = detail.customerGets?.value?.amount?.amount;
  let amount: NewDiscountAmount;
  if (typeof percentRaw === "number" && percentRaw > 0) {
    // Shopify returns percentage as 0-1 decimal. Convert to whole percent.
    const whole = percentRaw <= 1 ? percentRaw * 100 : percentRaw;
    amount = { kind: "percentage", percent: Math.round(whole * 100) / 100 };
  } else if (typeof amountRaw === "string" && amountRaw.length > 0) {
    const parsed = Number(amountRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    amount = { kind: "fixed", amount: parsed };
  } else {
    return null;
  }

  return {
    discountNodeId: node.id,
    amount,
    appliesOncePerCustomer: Boolean(detail.appliesOncePerCustomer),
    endsAt: detail.endsAt ?? null,
  };
}

/**
 * Deactivate an existing native discount. Must run BEFORE
 * `discountCodeAppCreate` with the same code — Shopify enforces code-string
 * uniqueness across active discounts.
 */
async function renameAndDeactivateNativeDiscount(
  client: AdminGqlClient,
  discountNodeId: string,
  archiveCode: string,
): Promise<void> {
  const body = await runGql<DiscountCodeRenameAndDeactivateData>(
    client,
    DISCOUNT_CODE_RENAME_AND_DEACTIVATE,
    { id: discountNodeId, basicCodeDiscount: { code: archiveCode } },
    "discountCodeRenameAndDeactivate",
  );
  const renameErrors = body.data?.discountCodeBasicUpdate?.userErrors ?? [];
  const deactivateErrors = body.data?.discountCodeDeactivate?.userErrors ?? [];
  const allErrors = [...renameErrors, ...deactivateErrors];
  if (allErrors.length > 0) {
    throw new ShopifyUserError(allErrors);
  }
}

export async function discountCodeDeactivate(
  client: AdminGqlClient,
  discountNodeId: string,
): Promise<void> {
  const body = await runGql<DiscountCodeDeactivateData>(
    client,
    DISCOUNT_CODE_DEACTIVATE,
    { id: discountNodeId },
    "discountCodeDeactivate",
  );
  const payload = body.data?.discountCodeDeactivate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyUserError(payload.userErrors);
  }
}

/**
 * Permanently remove a discount code from the shop. Used during offer delete
 * to clean up the app-owned clone we created — deactivation alone would leave
 * clutter in the merchant's discount list.
 */
export async function discountCodeDelete(
  client: AdminGqlClient,
  discountNodeId: string,
): Promise<void> {
  const body = await runGql<DiscountCodeDeleteData>(
    client,
    DISCOUNT_CODE_DELETE,
    { id: discountNodeId },
    "discountCodeDelete",
  );
  const payload = body.data?.discountCodeDelete;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyUserError(payload.userErrors);
  }
}

/**
 * Rename a native discount back to a target code string AND activate it in one
 * round-trip. Used when restoring a replaced discount so the merchant's
 * original code name comes back (not the `_PG_*` archive name).
 *
 * Caller must ensure the target code string is free (i.e. the app-owned
 * replacement has been deleted first) — Shopify rejects rename collisions
 * even against deactivated discounts.
 */
async function renameAndActivateNativeDiscount(
  client: AdminGqlClient,
  discountNodeId: string,
  restoreCode: string,
): Promise<void> {
  const body = await runGql<DiscountCodeRenameAndActivateData>(
    client,
    DISCOUNT_CODE_RENAME_AND_ACTIVATE,
    { id: discountNodeId, basicCodeDiscount: { code: restoreCode } },
    "discountCodeRenameAndActivate",
  );
  const renameErrors = body.data?.discountCodeBasicUpdate?.userErrors ?? [];
  const activateErrors = body.data?.discountCodeActivate?.userErrors ?? [];
  const allErrors = [...renameErrors, ...activateErrors];
  if (allErrors.length > 0) {
    throw new ShopifyUserError(allErrors);
  }
}

export interface ReplaceInPlaceResult {
  discountNodeId: string;
  replacedDiscountNodeId: string;
  code: string;
}

/**
 * Silent-strip replace-in-place: deactivate the existing native discount,
 * then create an app-owned discount with the same code and copied config.
 *
 * Ordering matters — if we create first, Shopify rejects with
 * "code must be unique".
 */
export async function replaceInPlace(
  client: AdminGqlClient,
  args: { code: string },
): Promise<ReplaceInPlaceResult> {
  const resolved = await readNativeDiscountByCode(client, args.code);
  if (!resolved) {
    throw new Error(
      `replaceInPlace: could not resolve native discount for code "${args.code}"`,
    );
  }

  // Rename + deactivate in one round-trip. Rename frees the original code string
  // (Shopify enforces uniqueness even on deactivated codes).
  const archiveCode = `_PG_${args.code.toUpperCase()}_${Date.now().toString(36).toUpperCase()}`;
  await renameAndDeactivateNativeDiscount(client, resolved.discountNodeId, archiveCode);

  const created = await createNewProtectedDiscount(client, {
    code: args.code,
    amount: resolved.amount,
    appliesOncePerCustomer: resolved.appliesOncePerCustomer,
    endsAt: resolved.endsAt
      ? resolved.endsAt.slice(0, 10)
      : null,
  });

  return {
    discountNodeId: created.discountNodeId,
    replacedDiscountNodeId: resolved.discountNodeId,
    code: args.code,
  };
}

// -- Status transitions (T36) ----------------------------------------------

export type OfferStatus = "active" | "paused";

/**
 * Flip a protected offer's status. Scoped by shop so a merchant can only
 * touch their own offers. Returns the new status.
 *
 * The Validation/Discount Functions read `status` from the shop-level shards
 * at runtime and skip offers where status != "active" — so pausing takes
 * effect as soon as the metafield shard rebuild runs (T42's cold-start path
 * picks this up; `/offers/:id/edit` triggers it too).
 */
export async function setOfferStatus(args: {
  offerId: string;
  shopId: string;
  status: OfferStatus;
}): Promise<{ status: OfferStatus }> {
  const updated = await prisma.protectedOffer.updateMany({
    where: {
      id: args.offerId,
      shopId: args.shopId,
      archivedAt: null,
    },
    data: { status: args.status },
  });
  if (updated.count === 0) {
    throw new Error("setOfferStatus: offer not found or archived");
  }
  return { status: args.status };
}

export interface UpdateOfferFieldsInput {
  offerId: string;
  shopId: string;
  name?: string;
  mode?: "silent_strip" | "block";
}

/**
 * Update the editable fields of a protected offer. Codes and replaced-node
 * references are immutable through this path — T33/T34 handle those via
 * their own flows.
 */
export async function updateOfferFields(
  args: UpdateOfferFieldsInput,
): Promise<{ updated: boolean }> {
  const data: { name?: string; mode?: string } = {};
  if (typeof args.name === "string") data.name = args.name.trim();
  if (args.mode) data.mode = args.mode;
  if (Object.keys(data).length === 0) return { updated: false };

  const result = await prisma.protectedOffer.updateMany({
    where: {
      id: args.offerId,
      shopId: args.shopId,
      archivedAt: null,
    },
    data,
  });
  if (result.count === 0) {
    throw new Error("updateOfferFields: offer not found or archived");
  }
  return { updated: true };
}

// -- Delete with restore option (T37) --------------------------------------

const DISCOUNT_CODE_ACTIVATE = /* GraphQL */ `
  mutation DiscountCodeActivate($id: ID!) {
    discountCodeActivate(id: $id) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface DiscountCodeActivateData {
  discountCodeActivate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>;
  };
}

/**
 * Reactivate a previously-deactivated native discount, used when the merchant
 * deletes a protected offer and asks to restore the originals.
 *
 * Caveat: the replacement app-owned discount with the same code must be
 * deactivated first (enforced by caller flow in deleteOffer) — otherwise
 * Shopify rejects with the usual uniqueness error.
 */
export async function discountCodeActivate(
  client: AdminGqlClient,
  discountNodeId: string,
): Promise<void> {
  const body = await runGql<DiscountCodeActivateData>(
    client,
    DISCOUNT_CODE_ACTIVATE,
    { id: discountNodeId },
    "discountCodeActivate",
  );
  const payload = body.data?.discountCodeActivate;
  if (payload?.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyUserError(payload.userErrors);
  }
}

export interface DeleteOfferInput {
  offerId: string;
  shopId: string;
  /** When true, reactivate the replaced native discounts after deactivating our app-owned ones. */
  restoreReplaced: boolean;
}

export interface DeleteOfferResult {
  restoredDiscountNodeIds: string[];
}

/**
 * Soft-delete a protected offer (ProtectedOffer.archivedAt = now). Child
 * RedemptionRecord / FlaggedOrder rows are preserved so history and audit
 * trails survive.
 *
 * For every ProtectedCode with an app-owned clone (`isAppOwned`), we delete
 * that clone from Shopify — deactivation alone leaves clutter in the
 * merchant's discount list.
 *
 * When `restoreReplaced` is true, for each code with a `replacedDiscountNodeId`:
 *   1. Delete the app-owned replacement (frees the clean code string).
 *   2. Rename the replaced native back to its original code AND activate it
 *      (the `_PG_*` archive name disappears, the merchant sees their code
 *      back exactly as it was).
 *
 * Best-effort: if any Shopify call fails for a given code, the error is
 * re-thrown so the caller can surface it; the offer is NOT archived in that
 * case so the merchant can retry.
 */
export async function deleteOffer(
  client: AdminGqlClient,
  input: DeleteOfferInput,
): Promise<DeleteOfferResult> {
  const offer = await prisma.protectedOffer.findFirst({
    where: {
      id: input.offerId,
      shopId: input.shopId,
      archivedAt: null,
    },
    include: {
      codes: {
        where: { archivedAt: null },
      },
    },
  });
  if (!offer) {
    throw new Error("deleteOffer: offer not found or already archived");
  }

  const restored: string[] = [];
  for (const code of offer.codes) {
    // Always delete the app-owned clone first. This frees the clean code
    // string (so a rename can reuse it) and cleans up the merchant's admin.
    if (code.discountNodeId && code.isAppOwned) {
      await discountCodeDelete(client, code.discountNodeId);
    }

    if (input.restoreReplaced && code.replacedDiscountNodeId) {
      // Restore: put the original code string back on the native discount
      // and reactivate it. After this, the merchant's original is live
      // again with its pre-protection name.
      await renameAndActivateNativeDiscount(
        client,
        code.replacedDiscountNodeId,
        code.code,
      );
      restored.push(code.replacedDiscountNodeId);
    }
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.protectedCode.updateMany({
      where: { protectedOfferId: offer.id, archivedAt: null },
      data: { archivedAt: now },
    }),
    prisma.protectedOffer.update({
      where: { id: offer.id },
      data: { archivedAt: now, status: "archived" },
    }),
  ]);

  return { restoredDiscountNodeIds: restored };
}
