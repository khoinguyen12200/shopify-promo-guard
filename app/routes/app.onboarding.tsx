/**
 * See: docs/admin-ui-spec.md §3 (Onboarding)
 */
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";

import { SetupChecklist, type ChecklistItem } from "../components/setup-checklist";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }
  const [offerCount, codeCount, redemptionCount] = await Promise.all([
    prisma.protectedOffer.count({ where: { shopId: shop.id } }),
    prisma.protectedCode.count({
      where: { protectedOffer: { shopId: shop.id } },
    }),
    prisma.redemptionRecord.count({ where: { shopId: shop.id } }),
  ]);
  return { offerCount, codeCount, redemptionCount };
};

export default function Onboarding() {
  const { offerCount, codeCount, redemptionCount } =
    useLoaderData<typeof loader>();

  const offerDone = offerCount > 0;
  const codeDone = codeCount > 0;
  const redemptionDone = redemptionCount > 0;

  const items: ChecklistItem[] = [
    {
      id: "offer",
      title: "Create your first protected offer",
      description:
        "Define which welcome discount to protect from repeat abuse.",
      cta: { label: "Create your first offer", href: "/app/offers/new" },
      done: offerDone,
    },
    {
      id: "code",
      title: "Connect a discount code",
      description:
        "Link an existing Shopify discount code to your protected offer.",
      cta: { label: "Add a code", href: "/app/offers" },
      done: codeDone,
      disabled: !offerDone,
    },
    {
      id: "test",
      title: "Test with a sample order",
      description:
        "Place a test order using the protected code to verify the guard fires.",
      cta: { label: "View offers", href: "/app/offers" },
      done: redemptionDone,
      disabled: !codeDone,
    },
    {
      id: "strict",
      title: "Optional: enable strict block mode",
      description:
        "Switch from warn-only to hard-block at checkout once you trust the signal.",
      cta: {
        label: "Read the docs",
        href: "https://promo-guard.app/docs/strict-mode",
        external: true,
      },
      done: false,
    },
  ];

  return (
    <s-page heading="Welcome to Promo Guard">
      <s-section>
        <s-banner tone="info" heading="Get set up in three steps">
          <s-text>
            Promo Guard prevents repeat abuse of your welcome offers by matching
            identity signals beyond email — phone, address, device/IP, and
            similar email variants.
          </s-text>
        </s-banner>
      </s-section>
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
