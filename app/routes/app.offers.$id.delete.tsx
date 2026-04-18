/**
 * See: docs/admin-ui-spec.md §6 (Delete confirmation — with restore option)
 * Related: app/lib/offer-service.server.ts (deleteOffer)
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
import { deleteOffer } from "../lib/offer-service.server";
import { ShopifyUserError } from "../lib/admin-graphql.server";
import { requireReadOnly } from "../lib/admin-impersonation.server";
import { authenticate } from "../shopify.server";

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
    return { error: "Pick an option." };
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

  // Pre-select "restore" when the offer replaced native discounts — that's
  // the safer default per spec §6 (links in emails keep working).
  const [choice, setChoice] = useState<"restore" | "delete">(
    hasReplaced ? "restore" : "delete",
  );

  return (
    <s-page heading={`Delete — ${offer.name}`}>
      <s-section>
        <Form method="post">
          <s-stack gap="base">
            {actionData?.error ? (
              <s-banner tone="critical">{actionData.error}</s-banner>
            ) : null}

            {hasReplaced ? (
              <s-text>
                {offer.name} uses {replacedCodes.length}{" "}
                {replacedCodes.length === 1 ? "discount" : "discounts"} that we
                created for you ({replacedCodes.join(", ")}). Deleting this
                protected offer will:
              </s-text>
            ) : (
              <s-text>
                Deleting {offer.name} will stop the protection on{" "}
                {offer.codes.length}{" "}
                {offer.codes.length === 1 ? "code" : "codes"}.
              </s-text>
            )}

            {hasReplaced ? (
              <s-stack gap="small">
                <s-stack direction="inline" gap="small" alignItems="start">
                  <input
                    type="radio"
                    id="choice-restore"
                    name="choice"
                    value="restore"
                    checked={choice === "restore"}
                    onChange={() => setChoice("restore")}
                  />
                  <s-stack gap="small">
                    <label htmlFor="choice-restore">
                      <s-text>
                        Restore your original {replacedCodes.join(", ")}
                      </s-text>
                    </label>
                    <s-text color="subdued">
                      Unprotected, native Shopify versions from before
                    </s-text>
                  </s-stack>
                </s-stack>
                <s-stack direction="inline" gap="small" alignItems="start">
                  <input
                    type="radio"
                    id="choice-delete"
                    name="choice"
                    value="delete"
                    checked={choice === "delete"}
                    onChange={() => setChoice("delete")}
                  />
                  <s-stack gap="small">
                    <label htmlFor="choice-delete">
                      <s-text>Delete the codes entirely</s-text>
                    </label>
                    <s-text color="subdued">
                      Links using these codes will stop working.
                    </s-text>
                  </s-stack>
                </s-stack>
              </s-stack>
            ) : (
              <input type="hidden" name="choice" value="delete" />
            )}

            <s-stack direction="inline" gap="base">
              <s-button href={`/app/offers/${offer.id}`}>Cancel</s-button>
              <s-button type="submit" variant="primary" tone="critical">
                Delete
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
