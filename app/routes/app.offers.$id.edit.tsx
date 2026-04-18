/**
 * See: docs/admin-ui-spec.md §6 (Offer detail — Edit)
 * Related: app/lib/offer-service.server.ts (updateOfferFields)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import { useState } from "react";

import prisma from "../db.server";
import { requireReadOnly } from "../lib/admin-impersonation.server";
import { updateOfferFields } from "../lib/offer-service.server";
import { authenticate } from "../shopify.server";

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
  if (
    modeRaw !== "silent_strip" &&
    modeRaw !== "block" &&
    modeRaw !== "flag_only"
  ) {
    fieldErrors.mode = "Invalid mode.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: { name, mode: modeRaw } };
  }

  await updateOfferFields({
    offerId: id,
    shopId: shop.id,
    name,
    mode: modeRaw as "silent_strip" | "block" | "flag_only",
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

  return (
    <s-page heading={`Edit — ${offer.name}`}>
      <Form method="post">
        {fieldErrors?.form ? (
          <s-banner tone="critical">{fieldErrors.form}</s-banner>
        ) : null}

        <s-section heading="Name">
          <s-text-field
            name="name"
            label="Name"
            value={name}
            required
            error={fieldErrors?.name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </s-section>

        <s-section heading="Codes (read-only)">
          <s-stack direction="inline" gap="small">
            {offer.codes.length === 0 ? (
              <s-text color="subdued">No codes.</s-text>
            ) : (
              offer.codes.map((c) => (
                <s-badge key={c.id} tone="info">
                  {c.code}
                </s-badge>
              ))
            )}
          </s-stack>
          <s-text color="subdued">
            Codes can&apos;t be changed here. Delete and recreate the offer to
            change which codes are protected.
          </s-text>
        </s-section>

        <s-section heading="What happens when someone reuses this offer?">
          <s-stack gap="base">
            <s-stack direction="inline" gap="small" alignItems="start">
              <input
                type="radio"
                id="mode-silent"
                name="mode"
                value="silent_strip"
                checked={mode === "silent_strip"}
                onChange={() => setMode("silent_strip")}
              />
              <label htmlFor="mode-silent">
                <s-text>Silently don&apos;t apply the discount</s-text>
              </label>
            </s-stack>
            <s-stack direction="inline" gap="small" alignItems="start">
              <input
                type="radio"
                id="mode-block"
                name="mode"
                value="block"
                checked={mode === "block"}
                onChange={() => setMode("block")}
              />
              <label htmlFor="mode-block">
                <s-text>Block their checkout</s-text>
              </label>
            </s-stack>
            <s-stack direction="inline" gap="small" alignItems="start">
              <input
                type="radio"
                id="mode-flag"
                name="mode"
                value="flag_only"
                checked={mode === "flag_only"}
                onChange={() => setMode("flag_only")}
              />
              <label htmlFor="mode-flag">
                <s-text>Flag for review only (no action)</s-text>
              </label>
            </s-stack>
          </s-stack>
          {fieldErrors?.mode ? (
            <s-banner tone="critical">{fieldErrors.mode}</s-banner>
          ) : null}
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button href={`/app/offers/${offer.id}`}>Cancel</s-button>
            <s-button type="submit" variant="primary">
              Save changes
            </s-button>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}
