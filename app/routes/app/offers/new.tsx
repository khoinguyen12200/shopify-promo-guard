/**
 * See: docs/admin-ui-spec.md §5 (Create offer — /app/offers/new)
 * Related: app/lib/discount-query.server.ts (suggestDiscounts)
 */
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";

import { OfferForm, type CodePickerSuggestion } from "~/components/offer-form";
import prisma from "~/db.server";
import {
  suggestDiscounts,
  type DiscountSuggestion,
} from "~/lib/discount-query.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { enqueueColdStart } from "~/jobs/cold-start";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

// -- Loader -----------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  let suggestions: DiscountSuggestion[] = [];
  let suggestError: string | null = null;
  try {
    suggestions = await suggestDiscounts({
      client: admin.graphql,
      shopId: shop.id,
    });
  } catch (err) {
    suggestError =
      err instanceof Error ? err.message : "Unable to load discounts.";
  }

  const offerCount = await prisma.protectedOffer.count({
    where: { shopId: shop.id, archivedAt: null },
  });

  return {
    suggestions: suggestions as CodePickerSuggestion[],
    suggestError,
    isFirstOffer: offerCount === 0,
    shopDomain: session.shop,
  };
};

// -- Action -----------------------------------------------------------------

type FieldErrors = {
  name?: string;
  code?: string;
  form?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const code = String(form.get("code") ?? "").trim();
  const discountNodeIdRaw = String(form.get("discountNodeId") ?? "").trim();
  const discountNodeId = discountNodeIdRaw.length > 0 ? discountNodeIdRaw : null;

  const fieldErrors: FieldErrors = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (!code) fieldErrors.code = "Pick a code.";

  if (code) {
    const conflicting = await prisma.protectedOffer.findFirst({
      where: {
        shopId: shop.id,
        archivedAt: null,
        codeUpper: code.toUpperCase(),
      },
      select: { name: true },
    });
    if (conflicting) {
      fieldErrors.code = `"${code}" is already in another protected offer ("${conflicting.name}"). Pick a different code.`;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      fieldErrors,
      values: { name, code, discountNodeId: discountNodeId ?? "" },
    };
  }

  const offer = await prisma.protectedOffer.create({
    data: {
      shopId: shop.id,
      name,
      status: "active",
      code,
      codeUpper: code.toUpperCase(),
      discountNodeId,
    },
  });

  // NOTE: checkout-time validation is DISABLED while we migrate enforcement
  // from Validation Function → Discount Function (`enteredDiscountCodesReject`).
  // Validation Function can't see which discount code is applied, so it
  // over-blocks regular full-price checkouts. Post-order flagging via
  // `orders/paid` still runs and captures abuse signals into `FlaggedOrder`
  // for merchant review.

  // Backfill historical redemptions of this code so protection works from
  // the first checkout after creation. The worker processes async; if the
  // enqueue itself fails we surface a log line but don't block the redirect.
  try {
    await enqueueColdStart({
      shopId: shop.id,
      protectedOfferId: offer.id,
    });
  } catch (err) {
    console.error("[offers/new] failed to enqueue cold_start", err);
  }

  return redirect(`/app/offers/${offer.id}`);
};

// -- View -------------------------------------------------------------------

export default function NewOffer() {
  const { suggestions, suggestError, isFirstOffer, shopDomain } =
    useLoaderData<typeof loader>();
  const rawActionData = useActionData<typeof action>();
  const actionData =
    rawActionData && "fieldErrors" in rawActionData ? rawActionData : undefined;

  const fieldErrors = actionData?.fieldErrors;
  const submittedCode = actionData?.values?.code;
  const submittedDiscountNodeId = actionData?.values?.discountNodeId;

  return (
    <OfferForm
      pageHeading="New protected offer"
      submitLabel="Create offer"
      suggestions={suggestions}
      shopDomain={shopDomain}
      fieldErrors={fieldErrors}
      defaultValues={{
        name: actionData?.values?.name ?? (isFirstOffer ? "Welcome program" : undefined),
        code: submittedCode
          ? {
              code: submittedCode,
              discountNodeId: submittedDiscountNodeId || undefined,
            }
          : null,
      }}
      suggestError={suggestError}
    />
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
