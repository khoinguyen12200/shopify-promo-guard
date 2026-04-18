/**
 * See: docs/webhook-spec.md §7 (customers/data_request)
 * Related: app/jobs/compliance-data-export.ts
 *
 * GDPR data export request from a customer (relayed by Shopify). We must
 * acknowledge fast (200) and produce the export asynchronously. The route
 * persists a ComplianceRequest row carrying the raw payload, then enqueues
 * `compliance_data_export` for the worker to fulfil.
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

  const body = (payload ?? {}) as Record<string, unknown>;
  const customer = (body.customer ?? {}) as {
    id?: number | string;
    email?: string;
  };
  const customerGid =
    customer.id !== undefined && customer.id !== null
      ? `gid://shopify/Customer/${customer.id}`
      : null;

  const cr = await prisma.complianceRequest.create({
    data: {
      shopId: shopRow.id,
      topic: "customers/data_request",
      customerGid,
      payload: JSON.stringify(body),
      status: "pending",
    },
  });

  await enqueueJob({
    shopId: shopRow.id,
    type: "compliance_data_export",
    payload: { complianceRequestId: cr.id },
  });

  await markWebhookEventComplete(webhookEvent.id, { ok: true });

  return new Response(null, { status: 200 });
};
