/**
 * See: docs/webhook-spec.md §6 (app/uninstalled handler)
 * Related: app/jobs/handle-app-uninstalled.ts (the actual work)
 *
 * Receive Shopify's `app/uninstalled` webhook. Auth + dedup runs through the
 * shared middleware; on success we enqueue a background job and return 200
 * immediately so Shopify never retries on slow cleanup work.
 */

import type { ActionFunctionArgs } from "react-router";

import { enqueueJob } from "~/lib/jobs.server.js";
import {
  authenticateAndDedupWebhook,
  markWebhookEventComplete,
} from "~/lib/webhook-auth.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  const result = await authenticateAndDedupWebhook(request);
  if (result.kind === "response") return result.response;

  const { shopDomain, shopRow, webhookEvent } = result.data;

  try {
    await enqueueJob({
      shopId: shopRow.id,
      type: "app_uninstalled",
      payload: { shopDomain },
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
