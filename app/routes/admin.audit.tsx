/**
 * See: docs/platform-admin-spec.md §14 (admin audit log)
 * Append-only — UI never offers a delete path.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";

import { requireAdminSession } from "../lib/admin-auth.server.js";
import prisma from "../db.server.js";

const PAGE_SIZE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "";
  const email = url.searchParams.get("email") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (email) {
    where.adminUser = { email: { contains: email.toLowerCase() } };
  }

  const [rows, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        metadata: true,
        createdAt: true,
        adminUser: { select: { email: true } },
      },
    }),
    prisma.adminAuditLog.count({ where }),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      action: r.action,
      target: r.targetType && r.targetId ? `${r.targetType}/${r.targetId}` : "",
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
      adminEmail: r.adminUser?.email ?? "(system)",
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    filters: { action, email },
  };
};

function parseReason(metadata: string | null): string {
  if (!metadata) return "";
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && "reason" in parsed) {
      const r = (parsed as Record<string, unknown>).reason;
      return typeof r === "string" ? r : "";
    }
  } catch {
    return "";
  }
  return "";
}

export default function AdminAudit() {
  const { rows, total, page, pageSize, filters } =
    useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  function setFilter(key: "action" | "email", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next);
  }

  function gotoPage(p: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    setParams(next);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <s-page heading="Admin audit log">
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-text-field
            name="action"
            label="Action"
            value={filters.action}
            onChange={(e) => setFilter("action", e.currentTarget.value)}
          />
          <s-text-field
            name="email"
            label="Admin email contains"
            value={filters.email}
            onChange={(e) => setFilter("email", e.currentTarget.value)}
          />
        </s-stack>
        <s-text color="subdued">
          {total.toLocaleString()} entries · page {page} of {totalPages}
        </s-text>
      </s-section>

      <s-section>
        {rows.length === 0 ? (
          <s-text color="subdued">No entries match the filter.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Time (UTC)</s-table-header>
              <s-table-header>Admin</s-table-header>
              <s-table-header>Action</s-table-header>
              <s-table-header>Target</s-table-header>
              <s-table-header>Reason</s-table-header>
            </s-table-header-row>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>
                  {new Date(r.createdAt).toISOString().slice(0, 19) + "Z"}
                </s-table-cell>
                <s-table-cell>{r.adminEmail}</s-table-cell>
                <s-table-cell>{r.action}</s-table-cell>
                <s-table-cell>{r.target}</s-table-cell>
                <s-table-cell>{parseReason(r.metadata)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        )}
      </s-section>

      {totalPages > 1 ? (
        <s-section>
          <s-stack direction="inline" gap="small">
            <s-button disabled={page <= 1} onClick={() => gotoPage(page - 1)}>
              Previous
            </s-button>
            <s-button
              disabled={page >= totalPages}
              onClick={() => gotoPage(page + 1)}
            >
              Next
            </s-button>
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}
