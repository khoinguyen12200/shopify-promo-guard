/**
 * See: docs/webhook-spec.md §7 (customers/data_request → compliance_data_export)
 * Related: app/jobs/compliance-data-export.ts
 *
 * Integration test against the dev Postgres. Seeds a shop + protected offer
 * + redemption record, drives the export job, and asserts that the
 * ComplianceRequest row is marked completed with a JSON envelope that
 * surfaces the shop's data for that customerGid.
 */

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import prisma from "../db.server.js";
import { encrypt, loadKek, unwrapDek } from "../lib/crypto.server.js";
import { ensureShop } from "../lib/shop.server.js";
import { handleComplianceDataExport } from "./compliance-data-export.js";

const createdDomains: string[] = [];

function uniqueDomain(tag: string): string {
  const suffix = randomBytes(6).toString("hex");
  const domain = `test-gdprexport-${tag}-${suffix}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

afterAll(async () => {
  if (createdDomains.length > 0) {
    await prisma.shop.deleteMany({
      where: { shopDomain: { in: createdDomains } },
    });
  }
  await prisma.$disconnect();
});

describe("handleComplianceDataExport", () => {
  it("completes the ComplianceRequest with decrypted PII for the customer", async () => {
    const shop = await ensureShop({
      shopDomain: uniqueDomain("happy"),
      accessToken: "token",
      scope: "read_customers",
    });

    // Encrypt an email under the shop's DEK so the job can decrypt it.
    const kek = loadKek();
    const dek = unwrapDek(shop.encryptionKey, kek);
    const emailCiphertext = encrypt("customer@example.com", dek);
    dek.fill(0);
    kek.fill(0);

    const offer = await prisma.protectedOffer.create({
      data: { shopId: shop.id, name: "Welcome", mode: "monitor" },
    });

    const customerGid = "gid://shopify/Customer/123456";
    await prisma.redemptionRecord.create({
      data: {
        shopId: shop.id,
        protectedOfferId: offer.id,
        orderGid: "gid://shopify/Order/9001",
        orderName: "#1001",
        codeUsed: "WELCOME10",
        customerGid,
        emailCiphertext,
        emailCanonicalHash: "deadbeef",
      },
    });

    const request = await prisma.complianceRequest.create({
      data: {
        shopId: shop.id,
        topic: "customers/data_request",
        customerGid,
        payload: JSON.stringify({ customer: { id: 123456 } }),
        status: "pending",
      },
    });

    await handleComplianceDataExport({ complianceRequestId: request.id });

    const after = await prisma.complianceRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();

    const envelope = JSON.parse(after.payload) as {
      customerGid: string;
      redemptions: Array<{
        orderGid: string;
        email: string | null;
        hashes: { emailCanonicalHash: string | null };
      }>;
      flaggedOrders: unknown[];
    };
    expect(envelope.customerGid).toBe(customerGid);
    expect(envelope.redemptions).toHaveLength(1);
    expect(envelope.redemptions[0].orderGid).toBe("gid://shopify/Order/9001");
    expect(envelope.redemptions[0].email).toBe("customer@example.com");
    expect(envelope.redemptions[0].hashes.emailCanonicalHash).toBe("deadbeef");
    expect(envelope.flaggedOrders).toHaveLength(0);
  });

  it("returns an empty export when the ComplianceRequest has no customerGid", async () => {
    const shop = await ensureShop({
      shopDomain: uniqueDomain("nogid"),
      accessToken: "token",
      scope: "read_customers",
    });

    const request = await prisma.complianceRequest.create({
      data: {
        shopId: shop.id,
        topic: "customers/data_request",
        customerGid: null,
        payload: JSON.stringify({}),
        status: "pending",
      },
    });

    await handleComplianceDataExport({ complianceRequestId: request.id });

    const after = await prisma.complianceRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("completed");
    const envelope = JSON.parse(after.payload) as {
      redemptions: unknown[];
      flaggedOrders: unknown[];
    };
    expect(envelope.redemptions).toHaveLength(0);
    expect(envelope.flaggedOrders).toHaveLength(0);
  });

  it("no-ops if the ComplianceRequest row is gone", async () => {
    await expect(
      handleComplianceDataExport({ complianceRequestId: "does-not-exist" }),
    ).resolves.toBeUndefined();
  });
});
