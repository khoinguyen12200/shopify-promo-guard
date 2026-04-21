/**
 * See: docs/webhook-spec.md §7 (shop/redact)
 * Related: app/jobs/compliance-shop-redact.ts
 *
 * Integration test against the dev Postgres. Seeds a shop with cascading
 * children (offer + code + redemption + flagged order + shard state, plus
 * job/webhookEvent/auditLog/complianceRequest/session rows), runs the
 * purge job, and asserts every owned row is gone.
 */

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import prisma from "../db.server.js";
import { ensureShop } from "../lib/shop.server.js";
import {
  handleComplianceShopRedact,
  type ComplianceShopRedactPayload,
} from "./compliance-shop-redact.js";

const createdDomains: string[] = [];

function uniqueDomain(tag: string): string {
  const suffix = randomBytes(6).toString("hex");
  const domain = `test-shopredact-${tag}-${suffix}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

afterAll(async () => {
  if (createdDomains.length > 0) {
    await prisma.shop.deleteMany({
      where: { shopDomain: { in: createdDomains } },
    });
    await prisma.session.deleteMany({
      where: { shop: { in: createdDomains } },
    });
  }
  await prisma.$disconnect();
});

function ctxFor(shopId: string) {
  return {
    jobId: "test-job",
    shopId,
    updateProgress: async () => {},
  };
}

async function runJob(payload: ComplianceShopRedactPayload, shopId: string) {
  await handleComplianceShopRedact(payload, ctxFor(shopId));
}

describe("handleComplianceShopRedact", () => {
  it("cascade-deletes every shop-owned row and the Shop itself", async () => {
    const shopDomain = uniqueDomain("happy");
    const shop = await ensureShop({
      shopDomain,
      accessToken: "token-shopredact",
      scope: "write_products",
    });

    const offer = await prisma.protectedOffer.create({
      data: {
        shopId: shop.id,
        name: "Welcome",
        code: "welcome10",
        codeUpper: "WELCOME10",
      },
    });
    await prisma.redemptionRecord.create({
      data: {
        shopId: shop.id,
        protectedOfferId: offer.id,
        orderGid: "gid://shopify/Order/1",
        orderName: "#1",
        codeUsed: "WELCOME10",
      },
    });
    await prisma.flaggedOrder.create({
      data: {
        shopId: shop.id,
        protectedOfferId: offer.id,
        orderGid: "gid://shopify/Order/2",
        orderName: "#2",
        riskLevel: "high",
        score: 90,
        facts: "{}",
      },
    });
    await prisma.shardState.create({
      data: {
        protectedOfferId: offer.id,
        shardKey: "00",
        metafieldNamespace: "promo_guard",
        metafieldKey: "shard_00",
      },
    });
    await prisma.job.create({
      data: { shopId: shop.id, type: "noop", payload: "{}", status: "pending" },
    });
    await prisma.webhookEvent.create({
      data: {
        shopId: shop.id,
        topic: "shop/redact",
        webhookGid: `whk_${randomBytes(8).toString("hex")}`,
        payloadHash: "x",
        status: "pending",
      },
    });
    await prisma.auditLog.create({
      data: { shopId: shop.id, actorType: "test", action: "noop" },
    });
    await prisma.session.create({
      data: {
        id: `offline_${shopDomain}`,
        shop: shopDomain,
        state: "x",
        accessToken: "x",
        isOnline: false,
      },
    });

    const cr = await prisma.complianceRequest.create({
      data: {
        shopId: shop.id,
        topic: "shop/redact",
        payload: JSON.stringify({ shop_id: 1 }),
        status: "pending",
      },
    });

    await runJob(
      { complianceRequestId: cr.id, shopDomain },
      shop.id,
    );

    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).toBeNull();
    expect(
      await prisma.protectedOffer.findUnique({ where: { id: offer.id } }),
    ).toBeNull();
    expect(
      await prisma.complianceRequest.findUnique({ where: { id: cr.id } }),
    ).toBeNull();
    expect(
      await prisma.session.findMany({ where: { shop: shopDomain } }),
    ).toHaveLength(0);
    expect(
      await prisma.redemptionRecord.findMany({ where: { shopId: shop.id } }),
    ).toHaveLength(0);
    expect(
      await prisma.flaggedOrder.findMany({ where: { shopId: shop.id } }),
    ).toHaveLength(0);
    expect(
      await prisma.shardState.findMany({
        where: { protectedOfferId: offer.id },
      }),
    ).toHaveLength(0);
    expect(
      await prisma.job.findMany({ where: { shopId: shop.id } }),
    ).toHaveLength(0);
    expect(
      await prisma.webhookEvent.findMany({ where: { shopId: shop.id } }),
    ).toHaveLength(0);
    expect(
      await prisma.auditLog.findMany({ where: { shopId: shop.id } }),
    ).toHaveLength(0);
  });

  it("is idempotent if the shop has already been purged", async () => {
    const shopDomain = uniqueDomain("idem");
    const shop = await ensureShop({
      shopDomain,
      accessToken: "token-idem",
      scope: "write_products",
    });
    const cr = await prisma.complianceRequest.create({
      data: {
        shopId: shop.id,
        topic: "shop/redact",
        payload: "{}",
        status: "pending",
      },
    });

    await runJob({ complianceRequestId: cr.id, shopDomain }, shop.id);

    // Second call: shop is gone — must not throw.
    await expect(
      runJob({ complianceRequestId: cr.id, shopDomain }, shop.id),
    ).resolves.toBeUndefined();
  });

  it("throws on missing payload fields", async () => {
    await expect(
      runJob(
        { complianceRequestId: "", shopDomain: "" } as ComplianceShopRedactPayload,
        "noshop",
      ),
    ).rejects.toThrow(/missing/);
  });
});
