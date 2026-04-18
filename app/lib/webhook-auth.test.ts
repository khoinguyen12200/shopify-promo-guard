/**
 * See: docs/webhook-spec.md §3, §4
 * Related: app/lib/webhook-auth.server.ts
 *
 * Integration tests against the real dev Postgres. The Shopify SDK's
 * `authenticate.webhook` is mocked so we don't need a valid HMAC —
 * we exercise the layers the wrapper adds: shop lookup, dedup, and
 * WebhookEvent row creation.
 */

import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "../db.server.js";
import { ensureShop } from "./shop.server.js";

// Mock the Shopify SDK — `authenticate.webhook` is replaced with a vi.fn()
// whose return value each test controls. Declared as a top-level vi.mock so
// hoisting puts it in place before the SUT imports it.
vi.mock("../shopify.server.js", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

// Import AFTER the mock so the SUT resolves our stubbed module. The SUT file
// uses `.js` extensions for ESM; Vitest maps those to the source `.ts`.
const { authenticateAndDedupWebhook, markWebhookEventComplete } = await import(
  "./webhook-auth.server.js"
);
const { authenticate } = await import("../shopify.server.js");

const webhookMock = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;

const createdDomains: string[] = [];

function uniqueDomain(tag: string): string {
  const suffix = randomBytes(6).toString("hex");
  const domain = `test-webhookauth-${tag}-${suffix}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

function uniqueWebhookId(): string {
  return `whk_${randomBytes(8).toString("hex")}`;
}

function fakeRequest(body: unknown): Request {
  return new Request("https://example.test/webhooks/_test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  webhookMock.mockReset();
});

afterAll(async () => {
  if (createdDomains.length > 0) {
    await prisma.shop.deleteMany({
      where: { shopDomain: { in: createdDomains } },
    });
  }
  await prisma.$disconnect();
});

describe("authenticateAndDedupWebhook — happy path", () => {
  it("creates a WebhookEvent row and returns kind=ok for a fresh delivery", async () => {
    const shopDomain = uniqueDomain("happy");
    const shop = await ensureShop({
      shopDomain,
      accessToken: "token-happy",
      scope: "write_products",
    });

    const payload = { order: 1, hello: "world" };
    const webhookId = uniqueWebhookId();
    webhookMock.mockResolvedValueOnce({
      shop: shopDomain,
      topic: "ORDERS_PAID",
      payload,
      webhookId,
      apiVersion: "2025-10",
      webhookType: "webhooks",
      session: undefined,
      admin: undefined,
    });

    const request = fakeRequest(payload);
    const expectedHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    const result = await authenticateAndDedupWebhook(request);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");

    expect(result.data.shopDomain).toBe(shopDomain);
    expect(result.data.shopRow.id).toBe(shop.id);
    expect(result.data.topic).toBe("ORDERS_PAID");
    expect(result.data.payload).toEqual(payload);
    expect(result.data.webhookId).toBe(webhookId);
    expect(result.data.webhookEvent.webhookGid).toBe(webhookId);
    expect(result.data.webhookEvent.payloadHash).toBe(expectedHash);
    expect(result.data.webhookEvent.status).toBe("pending");
    expect(result.data.webhookEvent.shopId).toBe(shop.id);

    // Verify the row really landed in Postgres.
    const row = await prisma.webhookEvent.findUnique({
      where: { id: result.data.webhookEvent.id },
    });
    expect(row?.webhookGid).toBe(webhookId);
  });

  it("markWebhookEventComplete flips status to processed", async () => {
    const shopDomain = uniqueDomain("mark");
    await ensureShop({
      shopDomain,
      accessToken: "token-mark",
      scope: "write_products",
    });

    const webhookId = uniqueWebhookId();
    webhookMock.mockResolvedValueOnce({
      shop: shopDomain,
      topic: "ORDERS_PAID",
      payload: { ok: true },
      webhookId,
      apiVersion: "2025-10",
      webhookType: "webhooks",
      session: undefined,
      admin: undefined,
    });
    const result = await authenticateAndDedupWebhook(
      fakeRequest({ ok: true }),
    );
    if (result.kind !== "ok") throw new Error("expected ok");

    await markWebhookEventComplete(result.data.webhookEvent.id, { ok: true });

    const row = await prisma.webhookEvent.findUnique({
      where: { id: result.data.webhookEvent.id },
    });
    expect(row?.status).toBe("processed");
    expect(row?.processedAt).not.toBeNull();
    expect(row?.error).toBeNull();
  });
});

describe("authenticateAndDedupWebhook — invalid HMAC", () => {
  it("returns kind=response with 401 when authenticate.webhook throws", async () => {
    webhookMock.mockRejectedValueOnce(new Error("bad hmac"));

    const result = await authenticateAndDedupWebhook(
      fakeRequest({ anything: true }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("unreachable");
    expect(result.response.status).toBe(401);
  });

  it("passes through a Response thrown by the SDK (e.g. raw 401)", async () => {
    webhookMock.mockRejectedValueOnce(
      new Response("hmac mismatch", { status: 401 }),
    );

    const result = await authenticateAndDedupWebhook(
      fakeRequest({ anything: true }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("unreachable");
    expect(result.response.status).toBe(401);
  });
});

describe("authenticateAndDedupWebhook — dedup", () => {
  it("returns 200 silently on a duplicate webhookId without inserting another row", async () => {
    const shopDomain = uniqueDomain("dedup");
    await ensureShop({
      shopDomain,
      accessToken: "token-dedup",
      scope: "write_products",
    });

    const webhookId = uniqueWebhookId();
    const payload = { attempt: 1 };

    // First delivery — inserts the row.
    webhookMock.mockResolvedValueOnce({
      shop: shopDomain,
      topic: "ORDERS_PAID",
      payload,
      webhookId,
      apiVersion: "2025-10",
      webhookType: "webhooks",
      session: undefined,
      admin: undefined,
    });
    const first = await authenticateAndDedupWebhook(fakeRequest(payload));
    expect(first.kind).toBe("ok");

    // Second delivery — same webhookId, must short-circuit to 200.
    webhookMock.mockResolvedValueOnce({
      shop: shopDomain,
      topic: "ORDERS_PAID",
      payload,
      webhookId,
      apiVersion: "2025-10",
      webhookType: "webhooks",
      session: undefined,
      admin: undefined,
    });
    const second = await authenticateAndDedupWebhook(fakeRequest(payload));
    expect(second.kind).toBe("response");
    if (second.kind !== "response") throw new Error("unreachable");
    expect(second.response.status).toBe(200);

    // Only one row should exist for this webhookGid.
    const rows = await prisma.webhookEvent.findMany({
      where: { webhookGid: webhookId },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("authenticateAndDedupWebhook — unknown shop", () => {
  it("returns 200 with no WebhookEvent row when the shop is not installed", async () => {
    const unknownDomain = `test-webhookauth-ghost-${randomBytes(6).toString(
      "hex",
    )}.myshopify.com`;
    // Purposefully NOT calling ensureShop — the row doesn't exist.

    const webhookId = uniqueWebhookId();
    webhookMock.mockResolvedValueOnce({
      shop: unknownDomain,
      topic: "APP_UNINSTALLED",
      payload: { shop_domain: unknownDomain },
      webhookId,
      apiVersion: "2025-10",
      webhookType: "webhooks",
      session: undefined,
      admin: undefined,
    });

    const result = await authenticateAndDedupWebhook(
      fakeRequest({ shop_domain: unknownDomain }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("unreachable");
    expect(result.response.status).toBe(200);

    const rows = await prisma.webhookEvent.findMany({
      where: { webhookGid: webhookId },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("markWebhookEventComplete — failure branch", () => {
  it("records a failed status with the error message", async () => {
    const shopDomain = uniqueDomain("fail");
    await ensureShop({
      shopDomain,
      accessToken: "token-fail",
      scope: "write_products",
    });

    const webhookId = uniqueWebhookId();
    webhookMock.mockResolvedValueOnce({
      shop: shopDomain,
      topic: "ORDERS_PAID",
      payload: { boom: true },
      webhookId,
      apiVersion: "2025-10",
      webhookType: "webhooks",
      session: undefined,
      admin: undefined,
    });
    const result = await authenticateAndDedupWebhook(
      fakeRequest({ boom: true }),
    );
    if (result.kind !== "ok") throw new Error("expected ok");

    await markWebhookEventComplete(result.data.webhookEvent.id, {
      ok: false,
      error: "downstream blew up",
    });

    const row = await prisma.webhookEvent.findUnique({
      where: { id: result.data.webhookEvent.id },
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("downstream blew up");
  });
});
