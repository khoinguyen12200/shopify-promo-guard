/**
 * See: docs/admin-ui-spec.md §6 (Offer detail — Edit)
 * Standard: docs/polaris-standards.md §14 (details / edit-form pattern),
 *           §2 (form wraps s-page, primary-action slot)
 * Related: app/lib/offer-service.server.ts (updateOfferFields)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import { useState } from "react";

import prisma from "~/db.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { updateOfferFields } from "~/lib/offer-service.server";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

type FieldErrors = {
  name?: string;
  mode?: string;
  form?: string;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const offer = await prisma.protectedOffer.findFirst({
    where: { id, shopId: shop.id, archivedAt: null },
    select: {
      id: true,
      name: true,
      mode: true,
      codes: {
        where: { archivedAt: null },
        select: { id: true, code: true },
        orderBy: { addedAt: "asc" },
      },
    },
  });
  if (!offer) throw new Response("Offer not found", { status: 404 });
  return { offer };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const modeRaw = String(form.get("mode") ?? "");

  const fieldErrors: FieldErrors = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (modeRaw !== "silent_strip" && modeRaw !== "block") {
    fieldErrors.mode = "Pick one of the enforcement modes.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: { name, mode: modeRaw } };
  }

  await updateOfferFields({
    offerId: id,
    shopId: shop.id,
    name,
    mode: modeRaw as "silent_strip" | "block",
  });

  return redirect(`/app/offers/${id}`);
};

export default function EditOffer() {
  const { offer } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fieldErrors = actionData?.fieldErrors;

  const [name, setName] = useState(actionData?.values?.name ?? offer.name);
  const [mode, setMode] = useState(
    (actionData?.values?.mode as string) ?? offer.mode,
  );
  const cancelHref = `/app/offers/${offer.id}`;

  return (
    <Form method="post">
      <s-page heading={`Edit ${offer.name}`}>
        <s-link slot="breadcrumb-actions" href="/app/offers">
          Offers
        </s-link>
        <s-button slot="secondary-actions" href={cancelHref}>
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" type="submit">
          Save changes
        </s-button>

        {fieldErrors?.form ? (
          <s-banner tone="critical">{fieldErrors.form}</s-banner>
        ) : null}

        <s-section heading="Offer information">
          <s-grid gap="base">
            <s-text-field
              name="name"
              label="Name"
              labelAccessibilityVisibility="visible"
              value={name}
              required
              details="A short internal name you'll recognise in the offers list."
              error={fieldErrors?.name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </s-grid>
        </s-section>

        <s-section heading="Protected codes">
          <s-stack gap="small-300">
            {offer.codes.length === 0 ? (
              <s-paragraph color="subdued">No codes.</s-paragraph>
            ) : (
              <s-stack direction="inline" gap="small-200">
                {offer.codes.map((c) => (
                  <s-badge key={c.id} tone="info">
                    {c.code}
                  </s-badge>
                ))}
              </s-stack>
            )}
            <s-paragraph color="subdued">
              Codes can&apos;t be changed here. Delete and recreate the offer to
              change which codes are protected.
            </s-paragraph>
          </s-stack>
        </s-section>

        <s-section slot="aside" heading="Enforcement mode">
          <s-grid gap="small-300">
            <s-choice-list
              name="mode"
              label="Enforcement mode"
              labelAccessibilityVisibility="exclusive"
              values={[mode]}
              error={fieldErrors?.mode}
              onChange={(e) => {
                const value = (e.target as HTMLInputElement | null)?.value;
                if (value) setMode(value);
              }}
            >
              <s-choice value="silent_strip">
                Silently skip the discount (recommended)
              </s-choice>
              <s-choice value="block">Block their checkout</s-choice>
            </s-choice-list>
            <s-paragraph color="subdued">
              {mode === "silent_strip"
                ? "The customer can still check out — they just won't get the discount. Works best for most stores."
                : "Stops the checkout with an error message. Stronger, but can frustrate legitimate customers."}
            </s-paragraph>
          </s-grid>
        </s-section>
      </s-page>
    </Form>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
