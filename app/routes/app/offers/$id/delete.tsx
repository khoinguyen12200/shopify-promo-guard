/**
 * See: docs/admin-ui-spec.md §6 (Delete confirmation — with restore option)
 * Standard: docs/polaris-standards.md §2 (inlineSize="small" for focused flows),
 *           §14 (form wraps s-page, primary-action slot)
 * Related: app/lib/offer-service.server.ts (deleteOffer)
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
import { deleteOffer } from "~/lib/offer-service.server";
import { ShopifyUserError } from "~/lib/admin-graphql.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

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
      codes: {
        where: { archivedAt: null },
        select: {
          id: true,
          code: true,
          replacedDiscountNodeId: true,
        },
      },
    },
  });
  if (!offer) throw new Response("Offer not found", { status: 404 });

  const replacedCodes = offer.codes
    .filter((c) => c.replacedDiscountNodeId)
    .map((c) => c.code);

  return { offer, replacedCodes };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { admin, session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const form = await request.formData();
  const choice = String(form.get("choice") ?? "");
  if (choice !== "restore" && choice !== "delete") {
    return { error: "Pick whether to restore your original discount or delete it entirely." };
  }

  try {
    await deleteOffer(admin.graphql, {
      offerId: id,
      shopId: shop.id,
      restoreReplaced: choice === "restore",
    });
  } catch (err) {
    const message =
      err instanceof ShopifyUserError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Could not delete the offer.";
    return { error: message };
  }

  return redirect("/app/offers");
};

export default function DeleteOffer() {
  const { offer, replacedCodes } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const hasReplaced = replacedCodes.length > 0;
  const cancelHref = `/app/offers/${offer.id}`;

  // Pre-select "restore" when the offer replaced native discounts — that's
  // the safer default per spec §6 (links in emails keep working).
  const [choice, setChoice] = useState<"restore" | "delete">(
    hasReplaced ? "restore" : "delete",
  );

  return (
    <Form method="post">
      <s-page heading={`Delete ${offer.name}?`} inlineSize="small">
        <s-link slot="breadcrumb-actions" href={cancelHref}>
          {offer.name}
        </s-link>
        <s-button slot="secondary-actions" href={cancelHref}>
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          type="submit"
        >
          Delete offer
        </s-button>

        {actionData?.error ? (
          <s-banner tone="critical">{actionData.error}</s-banner>
        ) : null}

        <s-section heading="Confirm deletion">
          <s-stack gap="base">
            {hasReplaced ? (
              <s-paragraph>
                <s-text type="strong">{offer.name}</s-text> uses{" "}
                {replacedCodes.length}{" "}
                {replacedCodes.length === 1 ? "discount" : "discounts"} that we
                created for you ({replacedCodes.join(", ")}).
              </s-paragraph>
            ) : (
              <s-paragraph>
                Deleting <s-text type="strong">{offer.name}</s-text> will stop
                the protection on {offer.codes.length}{" "}
                {offer.codes.length === 1 ? "code" : "codes"}.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>

        {hasReplaced ? (
          <s-section heading="What should happen to your original discount?">
            <s-grid gap="small-300">
              <s-choice-list
                name="choice"
                label="Restore or delete"
                labelAccessibilityVisibility="exclusive"
                values={[choice]}
                onChange={(e) => {
                  const value = (e.target as HTMLInputElement | null)?.value;
                  if (value === "restore" || value === "delete")
                    setChoice(value);
                }}
              >
                <s-choice value="restore">
                  Restore the original {replacedCodes.join(", ")}
                </s-choice>
                <s-choice value="delete">Delete the codes entirely</s-choice>
              </s-choice-list>
              <s-paragraph color="subdued">
                {choice === "restore"
                  ? "The unprotected, native Shopify versions from before take over."
                  : "Any links or emails using these codes will stop working."}
              </s-paragraph>
            </s-grid>
          </s-section>
        ) : (
          <input type="hidden" name="choice" value="delete" />
        )}
      </s-page>
    </Form>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
