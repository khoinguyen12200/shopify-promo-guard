/**
 * See: docs/admin-ui-spec.md §6 (Delete confirmation)
 * Standard: docs/polaris-standards.md §2 (inlineSize="small" for focused flows),
 *           §14 (form wraps s-page, primary-action slot)
 * Related: app/lib/offer-service.server.ts (deleteOffer)
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

import prisma from "~/db.server";
import { deleteOffer } from "~/lib/offer-service.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { resolveShopGid } from "~/lib/shop.server";
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
    select: { id: true, name: true, code: true },
  });
  if (!offer) throw new Response("Offer not found", { status: 404 });

  return { offer };
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

  try {
    const shopGid = await resolveShopGid(shop, admin);
    await deleteOffer({
      client: admin.graphql,
      shop: {
        id: shop.id,
        shopDomain: shop.shopDomain,
        shopGid,
        saltHex: shop.salt,
      },
      offerId: id,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not delete the offer.";
    return { error: message };
  }

  return redirect("/app/offers");
};

export default function DeleteOffer() {
  const { offer } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const cancelHref = `/app/offers/${offer.id}`;

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
            <s-paragraph>
              The protected offer will be removed from Promo Guard.
            </s-paragraph>
            <s-paragraph color="subdued">
              Your discount code in Shopify ({offer.code}) is not affected —
              abusers will be able to redeem it again.
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
