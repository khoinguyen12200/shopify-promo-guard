/**
 * See: docs/webhook-spec.md §7 (shop/redact)
 * Related: app/jobs/compliance-shop-redact.ts (the actual purge)
 *
 * Receive Shopify's `shop/redact` GDPR webhook (~48h post-uninstall). Auth +
 * dedup runs through the shared middleware; on a fresh delivery we record a
 * `ComplianceRequest` row and enqueue the destructive purge job, then return
 * 200 immediately so Shopify never retries on slow cleanup work.
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server.js";
import { enqueueJob } from "../lib/jobs.server.js";
import {
  authenticateAndDedupWebhook,
  markWebhookEventComplete,
} from "../lib/webhook-auth.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  const result = await authenticateAndDedupWebhook(request);
  if (result.kind === "response") return result.response;

  const { shopRow, payload, webhookEvent } = result.data;

  try {
    const complianceRequest = await prisma.complianceRequest.create({
      data: {
        shopId: shopRow.id,
        topic: "shop/redact",
        payload: JSON.stringify(payload ?? null),
        status: "pending",
      },
    });

    await enqueueJob({
      shopId: shopRow.id,
      type: "compliance_shop_redact",
      payload: {
        complianceRequestId: complianceRequest.id,
        shopDomain: shopRow.shopDomain,
      },
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
