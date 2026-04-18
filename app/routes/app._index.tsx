/**
 * See: docs/admin-ui-spec.md §2 (route map) — /app redirects based on offer existence
 * Related: docs/admin-ui-spec.md §3 (onboarding) and §4 (offers list)
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { _count: { select: { protectedOffers: true } } },
  });
  if (!shop || shop._count.protectedOffers === 0) {
    return redirect("/app/onboarding");
  }
  return redirect("/app/offers");
};

export default function AppIndex() {
  return null;
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
