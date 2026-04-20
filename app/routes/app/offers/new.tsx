/**
 * See: docs/admin-ui-spec.md §5 (Create offer — /app/offers/new)
 * Related: app/lib/discount-query.server.ts (suggestDiscounts)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";

import { OfferForm } from "~/components/offer-form";
import prisma from "~/db.server";
import {
  suggestDiscounts,
  type DiscountSuggestion,
} from "~/lib/discount-query.server";
import {
  createNewProtectedDiscount,
  replaceInPlace,
  type NewDiscountAmount,
} from "~/lib/offer-service.server";
import { ShopifyUserError } from "~/lib/admin-graphql.server";
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

  return { suggestions, suggestError, isFirstOffer: offerCount === 0 };
};

// -- Action -----------------------------------------------------------------

type FieldErrors = {
  name?: string;
  codes?: string;
  form?: string;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const mode = String(form.get("mode") ?? "silent_strip");
  const code = String(form.get("protectedCode") ?? "").trim();
  const discountNodeId = String(form.get("protectedCodeDiscountId") ?? "") || undefined;
  const isAppOwned = form.get("protectedCodeIsAppOwned") === "true";
  const origin = String(form.get("protectedCodeOrigin") ?? "existing");

  const fieldErrors: FieldErrors = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (!code) fieldErrors.codes = "Pick a code.";
  if (mode !== "block" && mode !== "silent_strip") {
    fieldErrors.form = "Invalid mode.";
  }

  if (code) {
    const conflicting = await prisma.protectedCode.findFirst({
      where: {
        codeUpper: code.toUpperCase(),
        archivedAt: null,
        protectedOffer: { shopId: shop.id, archivedAt: null },
      },
      select: { protectedOffer: { select: { name: true } } },
    });
    if (conflicting) {
      fieldErrors.codes = `This code is already in another protected offer. Remove it from '${conflicting.protectedOffer.name}' first.`;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: { name, mode } };
  }

  type PreparedCode = {
    code: string;
    codeUpper: string;
    discountNodeId: string | null;
    isAppOwned: boolean;
    replacedDiscountNodeId: string | null;
  };

  let prepared: PreparedCode;

  if (origin === "new") {
    const rawNewDiscount = String(form.get("newDiscountData") ?? "");
    let newDiscountPercent = 0;
    let newDiscountFixed = 0;
    let newDiscountValueType = "percentage";
    let newDiscountEndsAt: string | null = null;
    try {
      const parsed = JSON.parse(rawNewDiscount) as Record<string, unknown>;
      newDiscountValueType = String(parsed.valueType ?? "percentage");
      if (newDiscountValueType === "percentage") {
        newDiscountPercent = Number(parsed.value ?? 0);
      } else {
        newDiscountFixed = Number(parsed.value ?? 0);
      }
      const hasEndDate = parsed.hasEndDate === true;
      const endDate = String(parsed.endDate ?? "");
      const endTime = String(parsed.endTime ?? "23:59");
      if (hasEndDate && endDate) {
        newDiscountEndsAt = `${endDate}T${endTime}:00Z`;
      }
    } catch {
      // use defaults
    }

    const amount: NewDiscountAmount =
      newDiscountValueType === "fixed"
        ? { kind: "fixed", amount: newDiscountFixed }
        : { kind: "percentage", percent: newDiscountPercent };

    try {
      const result = await createNewProtectedDiscount(admin.graphql, {
        code,
        amount,
        appliesOncePerCustomer: true,
        endsAt: newDiscountEndsAt,
      });
      prepared = {
        code: result.code,
        codeUpper: result.code.toUpperCase(),
        discountNodeId: result.discountNodeId,
        isAppOwned: true,
        replacedDiscountNodeId: null,
      };
    } catch (err) {
      const message =
        err instanceof ShopifyUserError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not create discount.";
      return { fieldErrors: { codes: message }, values: { name, mode } };
    }
  } else {
    const needsReplace = mode === "silent_strip" && !isAppOwned;
    if (needsReplace) {
      try {
        const result = await replaceInPlace(admin.graphql, { code });
        prepared = {
          code,
          codeUpper: code.toUpperCase(),
          discountNodeId: result.discountNodeId,
          isAppOwned: true,
          replacedDiscountNodeId: result.replacedDiscountNodeId,
        };
      } catch (err) {
        const message =
          err instanceof ShopifyUserError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Replace-in-place failed.";
        return {
          fieldErrors: { codes: `Could not replace "${code}" — ${message}` },
          values: { name, mode },
        };
      }
    } else {
      prepared = {
        code,
        codeUpper: code.toUpperCase(),
        discountNodeId: discountNodeId ?? null,
        isAppOwned,
        replacedDiscountNodeId: null,
      };
    }
  }

  const offer = await prisma.protectedOffer.create({
    data: {
      shopId: shop.id,
      name,
      mode,
      status: "active",
      codes: {
        create: [
          {
            code: prepared.code,
            codeUpper: prepared.codeUpper,
            discountNodeId: prepared.discountNodeId,
            isAppOwned: prepared.isAppOwned,
            replacedDiscountNodeId: prepared.replacedDiscountNodeId,
          },
        ],
      },
    },
  });

  // Backfill historical redemptions of this code so protection works from the
  // first checkout after creation. The worker processes this async; if the
  // enqueue itself fails we surface a log line but don't block the redirect —
  // the merchant can retry backfill from the offer detail page later.
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
  const { suggestions, suggestError, isFirstOffer } = useLoaderData<typeof loader>();
  const rawActionData = useActionData<typeof action>();
  const actionData =
    rawActionData && "fieldErrors" in rawActionData ? rawActionData : undefined;

  const fieldErrors = actionData?.fieldErrors;
  const mode = actionData?.values?.mode === "block" ? "block" : "silent_strip";

  return (
    <OfferForm
      pageHeading="New protected offer"
      submitLabel="Create offer"
      suggestions={suggestions}
      fieldErrors={fieldErrors}
      defaultValues={{
        name: actionData?.values?.name ?? (isFirstOffer ? "Starter" : undefined),
        mode,
      }}
      suggestError={suggestError}
    />
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
