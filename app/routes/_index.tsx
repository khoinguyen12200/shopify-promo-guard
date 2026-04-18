import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: 560,
        margin: "80px auto",
        padding: 24,
      }}
    >
      <h1>Promo Guard</h1>
      <p>Stop welcome-offer abuse on Shopify.</p>
      {showForm ? (
        <Form
          method="post"
          action="/auth/login"
          style={{ marginTop: 24, display: "grid", gap: 12 }}
        >
          <label>
            <span>Shop domain</span>
            <input type="text" name="shop" style={{ display: "block", width: "100%", padding: 8 }} />
            <span style={{ fontSize: 12, color: "#666" }}>
              e.g. my-shop-domain.myshopify.com
            </span>
          </label>
          <button type="submit">Log in</button>
        </Form>
      ) : null}
      <p style={{ marginTop: 32 }}>
        <a href="/home">Learn more about Promo Guard →</a>
      </p>
    </div>
  );
}
