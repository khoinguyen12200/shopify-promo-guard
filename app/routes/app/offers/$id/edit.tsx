/**
 * See: docs/admin-ui-spec.md §6 (Offer detail — Edit)
 * Standard: docs/polaris-standards.md §14 (details / edit-form pattern),
 *           §2 (form wraps s-page, primary-action slot)
 * Related: app/lib/offer-service.server.ts (updateOfferFields)
 */
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
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
    select: { id: true, name: true, code: true },
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

  const fieldErrors: FieldErrors = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: { name } };
  }

  await updateOfferFields({
    offerId: id,
    shopId: shop.id,
    name,
  });

  return redirect(`/app/offers/${id}`);
};

export default function EditOffer() {
  const { offer } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fieldErrors = actionData?.fieldErrors;

  const [name, setName] = useState(actionData?.values?.name ?? offer.name);
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
        </s-section>

        <s-section heading="Protected code">
          <s-stack gap="small-300">
            <s-stack direction="inline" gap="small-200">
              <s-badge tone="info">{offer.code}</s-badge>
            </s-stack>
            <s-paragraph color="subdued">
              The code can&apos;t be changed here. Delete and recreate the offer
              to protect a different code.
            </s-paragraph>
          </s-stack>
        </s-section>
      </s-page>
    </Form>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
