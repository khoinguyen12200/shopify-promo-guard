/**
 * See: docs/webhook-spec.md §5 (orders/paid)
 *      docs/scoring-spec.md §5.2 (post-order scoring)
 *
 * HTTP entry point: HMAC + dedup (shared middleware), then enqueue the
 * `orders_paid` background job and return 200 fast. The heavy lift —
 * normalize, hash, score, write FlaggedOrder, call Admin GraphQL — runs
 * inside the worker.
 */

import type { ActionFunctionArgs } from "react-router";

import { enqueueJob } from "../lib/jobs.server.js";
import {
  authenticateAndDedupWebhook,
  markWebhookEventComplete,
} from "../lib/webhook-auth.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  const result = await authenticateAndDedupWebhook(request);
  if (result.kind === "response") return result.response;

  const { shopDomain, shopRow, payload, webhookEvent } = result.data;

  try {
    await enqueueJob({
      shopId: shopRow.id,
      type: "orders_paid",
      payload: { shopDomain, orderJson: payload },
    });
    await markWebhookEventComplete(webhookEvent.id, { ok: true });
  } catch (err) {
    await markWebhookEventComplete(webhookEvent.id, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  return new Response(null, { status: 200 });
};
