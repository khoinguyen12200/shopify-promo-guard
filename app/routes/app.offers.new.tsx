/**
 * See: docs/admin-ui-spec.md §5 (Create offer — /app/offers/new)
 * Related: app/lib/discount-query.server.ts (suggestDiscounts)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";

import { OfferForm } from "../components/offer-form";
import type { SelectedCode } from "../components/code-picker";
import prisma from "../db.server";
import {
  suggestDiscounts,
  type DiscountSuggestion,
} from "../lib/discount-query.server";
import { authenticate } from "../shopify.server";

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

  const suggested = suggestions.filter((s) => s.appliesOncePerCustomer);
  const other = suggestions.filter((s) => !s.appliesOncePerCustomer);

  return { suggested, other, suggestError };
};

// -- Action -----------------------------------------------------------------

type FieldErrors = {
  name?: string;
  codes?: string;
  form?: string;
};

function parseSelected(raw: FormDataEntryValue | null): SelectedCode[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SelectedCode[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const code = typeof obj.code === "string" ? obj.code.trim() : "";
      if (!code) continue;
      const origin =
        obj.origin === "suggested" ||
        obj.origin === "other" ||
        obj.origin === "existing" ||
        obj.origin === "manual-missing"
          ? obj.origin
          : "existing";
      out.push({
        code,
        discountNodeId:
          typeof obj.discountNodeId === "string"
            ? obj.discountNodeId
            : undefined,
        isAppOwned: obj.isAppOwned === true,
        origin,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const mode = String(form.get("mode") ?? "silent_strip");
  const selected = parseSelected(form.get("selectedCodes"));

  const fieldErrors: FieldErrors = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (selected.length === 0) {
    fieldErrors.codes = "Pick at least one code.";
  }
  if (mode !== "block" && mode !== "silent_strip") {
    fieldErrors.form = "Invalid mode.";
  }

  // Enforce uniqueness of codeUpper across existing protected offers.
  if (selected.length > 0) {
    const uppers = Array.from(
      new Set(selected.map((s) => s.code.toUpperCase())),
    );
    const conflicting = await prisma.protectedCode.findMany({
      where: {
        codeUpper: { in: uppers },
        archivedAt: null,
        protectedOffer: { shopId: shop.id, archivedAt: null },
      },
      select: {
        codeUpper: true,
        protectedOffer: { select: { name: true } },
      },
    });
    if (conflicting.length > 0) {
      const first = conflicting[0];
      fieldErrors.codes = `This code is already in another protected offer. Remove it from '${first.protectedOffer.name}' first.`;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: { name, mode } };
  }

  const offer = await prisma.protectedOffer.create({
    data: {
      shopId: shop.id,
      name,
      mode,
      status: "active",
      codes: {
        create: selected.map((s) => ({
          code: s.code,
          codeUpper: s.code.toUpperCase(),
          discountNodeId: s.discountNodeId ?? null,
          isAppOwned: s.isAppOwned ?? false,
        })),
      },
    },
  });

  return redirect(`/app/offers/${offer.id}`);
};

// -- View -------------------------------------------------------------------

export default function NewOffer() {
  const { suggested, other, suggestError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const fieldErrors = actionData?.fieldErrors;
  const mode = actionData?.values?.mode === "block" ? "block" : "silent_strip";

  return (
    <s-page heading="New protected offer">
      {suggestError ? (
        <s-section>
          <s-banner tone="warning">
            We couldn&apos;t load discounts from your store. You can still add
            codes manually. ({suggestError})
          </s-banner>
        </s-section>
      ) : null}
      <OfferForm
        suggested={suggested}
        other={other}
        fieldErrors={fieldErrors}
        defaultValues={{
          name: actionData?.values?.name,
          mode,
        }}
      />
    </s-page>
  );
}
