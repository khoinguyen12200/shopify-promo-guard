import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { readImpersonationSession } from "~/lib/admin-impersonation.server";
import { env } from "~/lib/env.server";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { ensureShop } = await import("../lib/shop.server");
  await ensureShop({
    shopDomain: session.shop,
    accessToken: session.accessToken ?? "",
    scope: session.scope ?? "",
  });

  const impersonation = readImpersonationSession(request);

  return {
    apiKey: env.SHOPIFY_API_KEY,
    impersonation: impersonation
      ? {
          shopDomain: impersonation.shopDomain,
          expiresAt: impersonation.expiresAt,
        }
      : null,
  };
};

export default function App() {
  const { apiKey, impersonation } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {impersonation ? (
        <s-banner tone="critical">
          Impersonating <strong>{impersonation.shopDomain}</strong>. Read-only.
          Logged. Session expires{" "}
          {new Date(impersonation.expiresAt).toLocaleTimeString()}.
        </s-banner>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
