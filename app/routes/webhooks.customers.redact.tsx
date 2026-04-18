/**
 * See: docs/webhook-spec.md §7 (customers/redact)
 * Related: app/jobs/compliance-customer-redact.ts
 */
import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server.js";
import { enqueueJob } from "../lib/jobs.server.js";
import {
  authenticateAndDedupWebhook,
  markWebhookEventComplete,
} from "../lib/webhook-auth.server.js";

interface CustomerRedactPayload {
  customer?: { id?: number | string; email?: string };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const result = await authenticateAndDedupWebhook(request);
  if (result.kind === "response") return result.response;

  const { shopRow, payload, webhookEvent } = result.data;
  const body = (payload ?? {}) as CustomerRedactPayload;
  const customer = body.customer ?? {};
  const customerGid = customer.id
    ? `gid://shopify/Customer/${customer.id}`
    : null;

  try {
    const cr = await prisma.complianceRequest.create({
      data: {
        shopId: shopRow.id,
        topic: "customers/redact",
        customerGid,
        payload: JSON.stringify(body),
        status: "pending",
      },
    });

    await enqueueJob({
      shopId: shopRow.id,
      type: "compliance_customer_redact",
      payload: { complianceRequestId: cr.id },
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
