/**
 * See: docs/platform-admin-spec.md §7 (decrypted view — audited)
 * Related: docs/database-design.md § Encryption approach
 *
 * Hard rules (from CLAUDE.md):
 *   - decryption happens only in-memory, in this one action, and drops scope
 *   - the audit log NEVER receives raw PII; only the reason + row count
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";

import { PiiRevealWarning } from "../components/admin/pii-reveal-warning.js";
import { requireAdminSession } from "../lib/admin-auth.server.js";
import { logAdminAction } from "../lib/admin-audit.server.js";
import { decrypt, loadKek, unwrapDek } from "../lib/crypto.server.js";
import prisma from "../db.server.js";

const MAX_ROWS = 100;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdminSession(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { id: true, shopDomain: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  return { shop: { id: shop.id, shopDomain: shop.shopDomain } };
};

type DecryptedRow = {
  id: string;
  orderName: string;
  codeUsed: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  createdAt: string;
};

type ActionResponse =
  | { ok: true; rows: DecryptedRow[]; reason: string }
  | { ok: false; error: string };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const form = await request.formData();
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length < 5) {
    return {
      ok: false as const,
      error: "Reason is required (minimum 5 characters).",
    };
  }

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { id: true, shopDomain: true, encryptionKey: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const records = await prisma.redemptionRecord.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true,
      orderName: true,
      codeUsed: true,
      emailCiphertext: true,
      phoneCiphertext: true,
      addressCiphertext: true,
      createdAt: true,
    },
  });

  // Decrypt in-memory, drop scope ASAP. No raw PII leaves this block.
  const rows: DecryptedRow[] = (() => {
    const kek = loadKek();
    let dek: Buffer;
    try {
      dek = unwrapDek(shop.encryptionKey, kek);
    } finally {
      // Zero the KEK bytes once we're done with it.
      kek.fill(0);
    }
    try {
      return records.map((r) => ({
        id: r.id,
        orderName: r.orderName,
        codeUsed: r.codeUsed,
        email: r.emailCiphertext
          ? decrypt(r.emailCiphertext, dek).toString("utf8")
          : null,
        phone: r.phoneCiphertext
          ? decrypt(r.phoneCiphertext, dek).toString("utf8")
          : null,
        address: r.addressCiphertext
          ? decrypt(r.addressCiphertext, dek).toString("utf8")
          : null,
        createdAt: r.createdAt.toISOString(),
      }));
    } finally {
      dek.fill(0);
    }
  })();

  // Audit log: reason + row count only. NO decrypted PII.
  await logAdminAction({
    adminUserId: adminUser.id,
    action: "view_pii",
    targetType: "Shop",
    targetId: shop.id,
    metadata: {
      shopDomain: shop.shopDomain,
      reason,
      rowCount: rows.length,
    },
    ipAddress:
      request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
      undefined,
    userAgent: request.headers.get("User-Agent") ?? undefined,
  });

  return { ok: true as const, rows, reason };
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ShopRedemptions() {
  const { shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionResponse>();

  if (!actionData || !actionData.ok) {
    return (
      <s-page heading={`Redemptions — ${shop.shopDomain}`}>
        <PiiRevealWarning
          shopDomain={shop.shopDomain}
          error={actionData && !actionData.ok ? actionData.error : undefined}
        />
      </s-page>
    );
  }

  return (
    <s-page heading={`Redemptions — ${shop.shopDomain}`}>
      <s-section>
        <s-banner tone="info">
          Showing decrypted PII. Reason:{" "}
          <strong>{actionData.reason}</strong>. This view is logged.
        </s-banner>
      </s-section>
      <s-section heading={`Recent redemptions (${actionData.rows.length})`}>
        {actionData.rows.length === 0 ? (
          <s-text color="subdued">No redemptions recorded yet.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Code</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Phone</s-table-header>
              <s-table-header>Address</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            {actionData.rows.map((row) => (
              <s-table-row key={row.id}>
                <s-table-cell>{row.orderName}</s-table-cell>
                <s-table-cell>{row.codeUsed}</s-table-cell>
                <s-table-cell>{row.email ?? "—"}</s-table-cell>
                <s-table-cell>{row.phone ?? "—"}</s-table-cell>
                <s-table-cell>{row.address ?? "—"}</s-table-cell>
                <s-table-cell>{formatDate(row.createdAt)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
