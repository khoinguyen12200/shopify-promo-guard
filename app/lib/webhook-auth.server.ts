/**
 * See: docs/webhook-spec.md §3 (delivery guarantees)
 * Related: docs/webhook-spec.md §4 (common middleware pattern)
 *
 * Thin wrapper around `authenticate.webhook()` that layers in:
 *   1. HMAC verification (delegated to the SDK — throws → 401).
 *   2. Shop resolution. Unknown shop → 200 (Shopify stops retrying).
 *   3. Dedup via the unique `WebhookEvent.webhookGid` constraint.
 *   4. A fresh `WebhookEvent` row in `status="pending"` with a SHA-256 of the
 *      raw request body so the caller can enforce idempotency.
 *
 * The function returns EITHER a fully-populated result the caller handler
 * should act on, OR a Response the caller must return verbatim — keeping
 * all routing decisions centralised here.
 */

import { createHash } from "node:crypto";

import type { Shop, WebhookEvent } from "@prisma/client";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";

export interface AuthenticatedWebhook {
  shopDomain: string;
  shopRow: Shop;
  topic: string;
  payload: unknown; // Shopify SDK returns the JSON-parsed body.
  webhookId: string;
  webhookEvent: WebhookEvent;
}

export type AuthenticateWebhookResult =
  | { kind: "ok"; data: AuthenticatedWebhook }
  | { kind: "response"; response: Response };

/**
 * Authenticate + dedup an incoming Shopify webhook.
 *
 * Return shape:
 *   - `{ kind: "ok", data }` — a new `WebhookEvent` row was inserted; the
 *     caller owns it and must call `markWebhookEventComplete` after
 *     processing.
 *   - `{ kind: "response", response }` — the request should NOT be processed
 *     further; return the response as-is. Cases: invalid HMAC (401), unknown
 *     shop (200), duplicate webhookId (200).
 */
export async function authenticateAndDedupWebhook(
  request: Request,
): Promise<AuthenticateWebhookResult> {
  // Clone BEFORE Shopify consumes the body, so we can hash the raw payload.
  // Shopify's authenticate.webhook() reads the request stream internally and
  // returns the parsed payload — it does not expose the raw body.
  const cloneForHash = request.clone();

  // 1. HMAC verify + decode. The SDK throws on bad HMAC, returning a 401
  //    from the enclosing route automatically when unhandled. We catch to
  //    produce a plain Response so callers can return it without leaking
  //    SDK-specific error types.
  let shopDomain: string;
  let topic: string;
  let payload: unknown;
  let webhookId: string;
  try {
    const ctx = await authenticate.webhook(request);
    shopDomain = ctx.shop;
    topic = ctx.topic as string;
    payload = ctx.payload;
    webhookId = ctx.webhookId;
  } catch (err) {
    // The SDK throws a Response on HMAC failure; pass it through if so.
    if (err instanceof Response) {
      return { kind: "response", response: err };
    }
    return {
      kind: "response",
      response: new Response("unauthorized", { status: 401 }),
    };
  }

  // 2. Resolve our Shop row. Webhooks can land before install completes or
  //    after a hard delete — either way we have nothing to do, so return
  //    200 to tell Shopify to stop retrying.
  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain },
  });
  if (!shopRow) {
    console.warn(
      `[webhook-auth] received ${topic} for unknown shop ${shopDomain} — skipping`,
    );
    return {
      kind: "response",
      response: new Response("shop not installed", { status: 200 }),
    };
  }

  // Compute the SHA-256 of the raw body for the WebhookEvent row. We do this
  // lazily here so it only runs on otherwise-valid requests.
  const rawBody = await cloneForHash.text();
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");

  // 3 + 4. Atomic dedup via unique constraint on webhookGid. If a prior
  //         delivery is already in the table we short-circuit with 200;
  //         otherwise we insert a fresh `pending` row and hand it back.
  let webhookEvent: WebhookEvent;
  try {
    webhookEvent = await prisma.webhookEvent.create({
      data: {
        shopId: shopRow.id,
        topic,
        webhookGid: webhookId,
        payloadHash,
        status: "pending",
      },
    });
  } catch (err) {
    // Prisma P2002 == unique constraint violation on webhookGid → duplicate.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        kind: "response",
        response: new Response("duplicate", { status: 200 }),
      };
    }
    throw err;
  }

  return {
    kind: "ok",
    data: {
      shopDomain,
      shopRow,
      topic,
      payload,
      webhookId,
      webhookEvent,
    },
  };
}

/**
 * Mark a `WebhookEvent` row as processed (or failed) once the caller's
 * async work completes. Safe to call exactly once per row; a no-op if the
 * row disappeared (e.g. shop/redact cascade).
 */
export async function markWebhookEventComplete(
  id: string,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: result.ok
      ? { status: "processed", processedAt: new Date(), error: null }
      : { status: "failed", processedAt: new Date(), error: result.error },
  });
}
