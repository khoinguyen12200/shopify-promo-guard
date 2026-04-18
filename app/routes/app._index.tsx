/**
 * See: docs/admin-ui-spec.md §2 (route map) — /app redirects based on offer existence
 * Related: docs/admin-ui-spec.md §3 (onboarding) and §4 (offers list)
 *
 * The loader DOES NOT `throw redirect(...)`. Inside the Shopify admin
 * iframe, a server-side 302 response from a /app/* GET loader strips the
 * `Content-Security-Policy: frame-ancestors` header that `boundary.headers`
 * emits, and admin.shopify.com can no longer iframe the target — the
 * user ends up back on `/auth/login`. Instead we return the destination
 * as data and navigate client-side via App Bridge (which correctly
 * handles iframe-aware navigation).
 */
import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { _count: { select: { protectedOffers: true } } },
  });
  const destination =
    !shop || shop._count.protectedOffers === 0
      ? "/app/onboarding"
      : "/app/offers";
  return { destination };
};

export default function AppIndex() {
  const { destination } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  useEffect(() => {
    navigate(destination, { replace: true });
  }, [destination, navigate]);
  return null;
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
