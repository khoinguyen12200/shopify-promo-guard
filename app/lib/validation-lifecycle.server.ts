/**
 * Programmatically install + toggle Shopify's checkout validation for our
 * `promo-guard-validator` Function. Without this, the merchant would have to
 * manually wire the validation up under Settings → Checkout → Checkout Rules.
 *
 * Idempotent: `ensureValidation` queries the existing `validations` first,
 * creates if missing, updates if `enabled` differs from desired.
 *
 * Requires `read_validations,write_validations` access scopes (see
 * `shopify.app.toml`).
 */

import type { AdminGqlClient } from "./admin-graphql.server.js";

const FUNCTION_HANDLE = "promo-guard-validator";
const VALIDATION_TITLE = "Promo Guard";

// ---- Queries / mutations -------------------------------------------------

const LIST_VALIDATIONS = /* GraphQL */ `
  query PromoGuardValidations {
    validations(first: 50) {
      nodes {
        id
        title
        enabled
        shopifyFunction {
          id
          apiType
          app {
            handle
          }
        }
      }
    }
  }
`;

const VALIDATION_CREATE = /* GraphQL */ `
  mutation PromoGuardValidationCreate($validation: ValidationCreateInput!) {
    validationCreate(validation: $validation) {
      validation {
        id
        enabled
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const VALIDATION_UPDATE = /* GraphQL */ `
  mutation PromoGuardValidationUpdate(
    $id: ID!
    $validation: ValidationUpdateInput!
  ) {
    validationUpdate(id: $id, validation: $validation) {
      validation {
        id
        enabled
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ---- Response shapes -----------------------------------------------------

interface ValidationNode {
  id: string;
  title: string;
  enabled: boolean;
  shopifyFunction?: {
    id: string;
    apiType?: string | null;
    app?: { handle?: string | null } | null;
  } | null;
}

interface ListValidationsData {
  validations: { nodes: ValidationNode[] };
}

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

interface ValidationCreateData {
  validationCreate: {
    validation: { id: string; enabled: boolean } | null;
    userErrors: UserError[];
  };
}

interface ValidationUpdateData {
  validationUpdate: {
    validation: { id: string; enabled: boolean } | null;
    userErrors: UserError[];
  };
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ResponseLike {
  status?: number;
  json: () => Promise<unknown>;
}

function isResponseLike(x: unknown): x is ResponseLike {
  return !!x && typeof (x as ResponseLike).json === "function";
}

async function runGql<T>(
  client: AdminGqlClient,
  query: string,
  variables: Record<string, unknown>,
  op: string,
): Promise<GqlResponse<T>> {
  const call = client as unknown as (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<unknown>;
  const raw = await call(query, { variables });
  const body = isResponseLike(raw)
    ? ((await raw.json()) as GqlResponse<T>)
    : (raw as GqlResponse<T>);
  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `${op}: GraphQL errored: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return body;
}

function userErrorMessage(errors: UserError[]): string {
  return errors
    .map((e) => `${(e.field ?? []).join(".")} ${e.message}`.trim())
    .join("; ");
}

// ---- Public API ----------------------------------------------------------

/**
 * Find our validation in the shop, if it exists. We match by the function's
 * apiType (`cart_checkout_validation`) — this avoids a brittle title-string
 * match and works even after a function rename in the toml.
 */
async function findOurValidation(
  client: AdminGqlClient,
): Promise<ValidationNode | null> {
  const body = await runGql<ListValidationsData>(
    client,
    LIST_VALIDATIONS,
    {},
    "validations",
  );
  const nodes = body.data?.validations?.nodes ?? [];
  return (
    nodes.find(
      (n) =>
        typeof n.shopifyFunction?.apiType === "string" &&
        n.shopifyFunction.apiType.toLowerCase() === "cart_checkout_validation",
    ) ?? null
  );
}

/**
 * Ensure the validation is installed and in the desired enabled state. Safe to
 * call repeatedly — the only writes happen when the actual state diverges.
 *
 * Returns the validation's GID so callers can reference it later.
 */
export async function ensureValidation(
  client: AdminGqlClient,
  enabled: boolean,
): Promise<{ id: string; enabled: boolean }> {
  const existing = await findOurValidation(client);

  if (!existing) {
    const body = await runGql<ValidationCreateData>(
      client,
      VALIDATION_CREATE,
      {
        validation: {
          functionHandle: FUNCTION_HANDLE,
          enable: enabled,
          title: VALIDATION_TITLE,
          blockOnFailure: false,
        },
      },
      "validationCreate",
    );
    const payload = body.data?.validationCreate;
    if (!payload?.validation) {
      throw new Error(
        `validationCreate failed: ${userErrorMessage(payload?.userErrors ?? [])}`,
      );
    }
    return payload.validation;
  }

  if (existing.enabled === enabled) {
    return { id: existing.id, enabled: existing.enabled };
  }

  const body = await runGql<ValidationUpdateData>(
    client,
    VALIDATION_UPDATE,
    {
      id: existing.id,
      validation: { enable: enabled },
    },
    "validationUpdate",
  );
  const payload = body.data?.validationUpdate;
  if (!payload?.validation) {
    throw new Error(
      `validationUpdate failed: ${userErrorMessage(payload?.userErrors ?? [])}`,
    );
  }
  return payload.validation;
}
