/**
 * See: docs/webhook-spec.md §7 (customers/data_request → compliance_data_export)
 * Related: docs/database-design.md § Encryption approach
 *
 * Worker job that fulfils a GDPR data export request.
 *
 *   1. Load the ComplianceRequest row.
 *   2. Pull every RedemptionRecord + FlaggedOrder we hold for this customer
 *      (matched by customerGid — emails are stored only as hashes, so we have
 *      no other safe lookup key).
 *   3. Decrypt any per-record PII ciphertexts in-memory using the shop's DEK.
 *   4. Persist the JSON export back onto ComplianceRequest.payload (the merchant
 *      retrieves it via the platform admin tool and delivers to the customer
 *      themselves — we never email them directly).
 *   5. Mark the request `completed`.
 *
 * Hard rule: decrypted PII never leaves this function. We assemble the JSON
 * blob, write it, then drop scope. No logging of plaintext.
 */

import prisma from "../db.server.js";
import { decrypt, loadKek, unwrapDek } from "../lib/crypto.server.js";

export interface ComplianceDataExportPayload {
  complianceRequestId: string;
}

interface RedemptionExport {
  id: string;
  orderGid: string;
  orderName: string;
  protectedOfferId: string;
  customerGid: string | null;
  redeemedAt: string;
  // Decrypted PII fields — present only if we had ciphertext for them.
  email: string | null;
  phone: string | null;
  address: string | null;
  ip: string | null;
  // Hash-only fields are returned as opaque hex; they're not PII on their own
  // but the customer is entitled to them under GDPR's "data we hold" rule.
  hashes: {
    phoneHash: string | null;
    emailCanonicalHash: string | null;
    addressFullHash: string | null;
    ipHash24: string | null;
  };
}

interface FlaggedOrderExport {
  id: string;
  orderGid: string;
  orderName: string;
  protectedOfferId: string;
  riskLevel: string;
  score: number;
  createdAt: string;
}

interface ExportEnvelope {
  customerGid: string | null;
  generatedAt: string;
  redemptions: RedemptionExport[];
  flaggedOrders: FlaggedOrderExport[];
}

export async function handleComplianceDataExport(
  payload: ComplianceDataExportPayload,
): Promise<void> {
  const { complianceRequestId } = payload;
  if (!complianceRequestId) {
    throw new Error(
      "compliance_data_export: missing complianceRequestId in payload",
    );
  }

  const request = await prisma.complianceRequest.findUnique({
    where: { id: complianceRequestId },
  });
  if (!request) {
    // Already processed and cascaded away (e.g. shop redacted) — nothing to do.
    return;
  }

  const shop = await prisma.shop.findUnique({ where: { id: request.shopId } });
  if (!shop) {
    // Shop is gone, so by definition we no longer hold any data for the
    // customer. Mark complete with an empty export.
    await prisma.complianceRequest.update({
      where: { id: complianceRequestId },
      data: {
        status: "completed",
        completedAt: new Date(),
        payload: JSON.stringify({
          customerGid: request.customerGid,
          generatedAt: new Date().toISOString(),
          redemptions: [],
          flaggedOrders: [],
        } satisfies ExportEnvelope),
      },
    });
    return;
  }

  // We can only match by customerGid — emails are stored as hashes, and we
  // can't reverse them without the customer's plaintext (which we hash with a
  // per-shop salt). The data_request payload from Shopify gives us the
  // customer.id; that's what's already on RedemptionRecord.customerGid.
  const customerGid = request.customerGid;
  // Without a customerGid we have no safe way to match — emails are stored
  // only as salted hashes that can't be reversed from a webhook payload.
  // Return an empty export rather than guessing.
  const redemptions = customerGid
    ? await prisma.redemptionRecord.findMany({
        where: { shopId: shop.id, customerGid },
      })
    : [];
  const flaggedOrders = customerGid
    ? await prisma.flaggedOrder.findMany({
        where: { shopId: shop.id, customerGid },
      })
    : [];

  // Decrypt PII in a tight scope — KEK + DEK live only inside this try.
  const kek = loadKek();
  const dek = unwrapDek(shop.encryptionKey, kek);

  let exportEnvelope: ExportEnvelope;
  try {
    const redemptionExports: RedemptionExport[] = redemptions.map((r) => ({
      id: r.id,
      orderGid: r.orderGid,
      orderName: r.orderName,
      protectedOfferId: r.protectedOfferId,
      customerGid: r.customerGid,
      redeemedAt: r.createdAt.toISOString(),
      email: r.emailCiphertext
        ? decrypt(r.emailCiphertext, dek).toString("utf8")
        : null,
      phone: r.phoneCiphertext
        ? decrypt(r.phoneCiphertext, dek).toString("utf8")
        : null,
      address: r.addressCiphertext
        ? decrypt(r.addressCiphertext, dek).toString("utf8")
        : null,
      ip: r.ipCiphertext
        ? decrypt(r.ipCiphertext, dek).toString("utf8")
        : null,
      hashes: {
        phoneHash: r.phoneHash,
        emailCanonicalHash: r.emailCanonicalHash,
        addressFullHash: r.addressFullHash,
        ipHash24: r.ipHash24,
      },
    }));

    const flaggedExports: FlaggedOrderExport[] = flaggedOrders.map((f) => ({
      id: f.id,
      orderGid: f.orderGid,
      orderName: f.orderName,
      protectedOfferId: f.protectedOfferId,
      riskLevel: f.riskLevel,
      score: f.score,
      createdAt: f.createdAt.toISOString(),
    }));

    exportEnvelope = {
      customerGid,
      generatedAt: new Date().toISOString(),
      redemptions: redemptionExports,
      flaggedOrders: flaggedExports,
    };
  } finally {
    // Best-effort wipe of the decrypted DEK before it gets GC'd.
    dek.fill(0);
    kek.fill(0);
  }

  await prisma.complianceRequest.update({
    where: { id: complianceRequestId },
    data: {
      status: "completed",
      completedAt: new Date(),
      payload: JSON.stringify(exportEnvelope),
      error: null,
    },
  });
}
