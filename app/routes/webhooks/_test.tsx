/**
 * See: docs/webhook-spec.md §3, §4
 * Related: app/lib/webhook-auth.server.ts
 *
 * Dev-only HMAC sanity route. NOT subscribed in shopify.app.toml — it only
 * exists so a developer can manually POST a request and watch the
 * auth + dedup middleware run end-to-end. Returns 404 in production.
 *
 * Try it locally with:
 *   curl -X POST http://localhost:3000/webhooks/_test \
 *     -H "X-Shopify-Hmac-Sha256: <hmac>" \
 *     -H "X-Shopify-Shop-Domain: my-shop.myshopify.com" \
 *     -H "X-Shopify-Topic: orders/paid" \
 *     -H "X-Shopify-Webhook-Id: <uuid>" \
 *     --data '{"id":1}'
 */

import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { env } from "~/lib/env.server.js";

export async function loader(_args: LoaderFunctionArgs) {
  void _args;
  if (env.NODE_ENV === "production") {
    throw data({ error: "not found" }, { status: 404 });
  }
  return data({
    hint: "POST with a raw body + X-Shopify-Hmac-Sha256 + X-Shopify-Shop-Domain + X-Shopify-Topic + X-Shopify-Webhook-Id",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (env.NODE_ENV === "production") {
    throw data({ error: "not found" }, { status: 404 });
  }
  // Dynamic import so this handler can't accidentally pull the auth module
  // into production bundles at route discovery time.
  const { authenticateAndDedupWebhook } = await import(
    "~/lib/webhook-auth.server.js"
  );
  const res = await authenticateAndDedupWebhook(request);
  if (res.kind === "response") return res.response;
  return data({
    ok: true,
    topic: res.data.topic,
    webhookId: res.data.webhookId,
  });
}
