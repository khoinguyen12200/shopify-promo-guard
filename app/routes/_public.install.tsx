/**
 * See: docs/landing-page-spec.md §8 (install route)
 * Related: docs/admin-ui-spec.md §2 (Shopify OAuth wiring)
 */

import { useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Install Promo Guard" },
  {
    name: "description",
    content:
      "Install Promo Guard on your Shopify store. Enter your shop domain to start the OAuth flow.",
  },
];

// Shopify shop domain format: lowercase alphanumeric + dash, 1–50 chars, then
// `.myshopify.com`. Matches the spec in docs/landing-page-spec.md §8.
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}\.myshopify\.com$/;

function normalizeShopInput(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let shop = raw.trim().toLowerCase();
  // Strip protocol + trailing path if the user pasted a full URL.
  shop = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Allow bare subdomain like `my-shop` and append `.myshopify.com`.
  if (!shop.includes(".") && shop.length > 0) {
    shop = `${shop}.myshopify.com`;
  }
  return SHOP_PATTERN.test(shop) ? shop : null;
}

type LoaderData = { prefill: string; error: string | null };

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<LoaderData | Response> => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  if (shopParam !== null) {
    const shop = normalizeShopInput(shopParam);
    if (shop) {
      return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }
    return {
      prefill: shopParam,
      error: "That doesn't look like a valid Shopify store domain.",
    };
  }
  return { prefill: "", error: null };
};

type ActionData = { prefill: string; error: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData | Response> => {
  const form = await request.formData();
  const raw = form.get("shop");
  const shopParam = typeof raw === "string" ? raw : "";
  const shop = normalizeShopInput(shopParam);
  if (shop) {
    return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  return {
    prefill: shopParam,
    error:
      "Enter a Shopify store domain like example.myshopify.com (or just example).",
  };
};

export default function PublicInstall() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const data = actionData ?? loaderData;
  const [shop, setShop] = useState(data.prefill);
  const error = data.error;

  return (
    <section className="pg-install" aria-labelledby="pg-install-heading">
      <div className="pg-install__inner">
        <h1 id="pg-install-heading" className="pg-install__heading">
          Install Promo Guard
        </h1>
        <p className="pg-install__sub">
          Enter your Shopify store domain. We&apos;ll hand off to Shopify&apos;s
          standard install flow — no account creation on our side.
        </p>
        <Form method="post" className="pg-install__form" noValidate>
          <label htmlFor="shop" className="pg-install__label">
            Store domain
          </label>
          <input
            id="shop"
            name="shop"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
            required
            placeholder="example.myshopify.com"
            value={shop}
            onChange={(e) => setShop(e.currentTarget.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "pg-install-error" : undefined}
            className="pg-install__input"
          />
          {error ? (
            <p
              id="pg-install-error"
              className="pg-install__error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="pg-btn pg-btn--primary pg-install__submit"
          >
            Install on Shopify
          </button>
        </Form>
        <p className="pg-install__hint">
          Not sure what your domain is? Open your Shopify admin — it&apos;s the
          address in the browser bar ending in <code>.myshopify.com</code>.
        </p>
      </div>
    </section>
  );
}
