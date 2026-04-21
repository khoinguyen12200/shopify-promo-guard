/**
 * See: docs/admin-ui-spec.md §3 (Onboarding)
 */
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";

import { SetupChecklist, type ChecklistItem } from "~/components/setup-checklist";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }
  const [offerCount, redemptionCount] = await Promise.all([
    prisma.protectedOffer.count({ where: { shopId: shop.id } }),
    prisma.redemptionRecord.count({ where: { shopId: shop.id } }),
  ]);
  return { offerCount, redemptionCount };
};

export default function Onboarding() {
  const { offerCount, redemptionCount } = useLoaderData<typeof loader>();

  const offerDone = offerCount > 0;
  const redemptionDone = redemptionCount > 0;

  const items: ChecklistItem[] = [
    {
      id: "offer",
      title: "Create your first protected offer",
      description:
        "Pick a welcome discount code to protect from repeat abuse.",
      cta: { label: "Create your first offer", href: "/app/offers/new" },
      done: offerDone,
    },
    {
      id: "test",
      title: "Test with a sample order",
      description:
        "Place a test order using the protected code to verify the guard fires.",
      cta: { label: "View offers", href: "/app/offers" },
      done: redemptionDone,
      disabled: !offerDone,
    },
  ];

  return (
    <s-page heading="Welcome to Promo Guard">
      <s-button slot="secondary-actions" href="/app/offers">
        Skip — I&apos;ll set up later
      </s-button>

      <s-banner tone="info" heading="Get set up in three steps">
        Promo Guard prevents repeat abuse of your welcome offers by matching
        identity signals beyond email — phone, address, device/IP, and similar
        email variants.
      </s-banner>

      <s-section heading="Setup checklist">
        <SetupChecklist items={items} />
      </s-section>
    </s-page>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
