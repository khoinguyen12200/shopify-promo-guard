/**
 * See: docs/platform-admin-spec.md §11 (GDPR queue)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { requireAdminSession } from "~/lib/admin-auth.server.js";
import { logAdminAction } from "~/lib/admin-audit.server.js";
import prisma from "~/db.server.js";

const TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const rows = await prisma.complianceRequest.findMany({
    orderBy: { receivedAt: "desc" },
    take: 200,
    select: {
      id: true,
      topic: true,
      status: true,
      customerGid: true,
      receivedAt: true,
      completedAt: true,
      error: true,
      shop: { select: { shopDomain: true } },
    },
  });

  const grouped: Record<string, typeof rows> = {};
  for (const t of TOPICS) grouped[t] = [];
  for (const r of rows) {
    (grouped[r.topic] ?? (grouped[r.topic] = [])).push(r);
  }
  return {
    grouped: Object.fromEntries(
      Object.entries(grouped).map(([topic, items]) => [
        topic,
        items.map((r) => ({
          id: r.id,
          status: r.status,
          customerGid: r.customerGid,
          receivedAt: r.receivedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          error: r.error,
          shopDomain: r.shop.shopDomain,
        })),
      ]),
    ),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  const form = await request.formData();
  const requestId = String(form.get("requestId") ?? "");
  if (!requestId) return { error: "requestId required" };

  const existing = await prisma.complianceRequest.findUnique({
    where: { id: requestId },
    select: { id: true, topic: true, shopId: true, status: true },
  });
  if (!existing) return { error: "Not found." };

  // Enqueue a retry job scoped to this request. The existing compliance
  // worker (T19-T22) is the owner of the actual redaction logic — this
  // page just pokes the queue so SLA doesn't get missed.
  await prisma.job.create({
    data: {
      shopId: existing.shopId,
      type: "compliance_retry",
      status: "pending",
      payload: JSON.stringify({
        complianceRequestId: existing.id,
        topic: existing.topic,
      }),
    },
  });

  await logAdminAction({
    adminUserId: adminUser.id,
    action: "compliance_retry",
    targetType: "ComplianceRequest",
    targetId: existing.id,
    metadata: { topic: existing.topic },
  });

  return { ok: true as const };
};

function age(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "1d old" : `${days}d old`;
}

export default function Compliance() {
  const { grouped } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Compliance requests">
      {actionData?.error ? (
        <s-section>
          <s-banner tone="critical">{actionData.error}</s-banner>
        </s-section>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <s-section>
          <s-banner tone="success">Retry queued.</s-banner>
        </s-section>
      ) : null}

      {TOPICS.map((topic) => {
        const items = grouped[topic] ?? [];
        return (
          <s-section key={topic} heading={topic}>
            {items.length === 0 ? (
              <s-text color="subdued">(none)</s-text>
            ) : (
              <s-stack gap="small">
                {items.map((r) => (
                  <s-stack
                    key={r.id}
                    direction="inline"
                    gap="base"
                    alignItems="center"
                  >
                    <s-text>
                      {r.shopDomain}
                      {r.customerGid ? ` · customer ${r.customerGid}` : ""} ·{" "}
                      {r.status} · {age(r.receivedAt)}
                    </s-text>
                    {r.status === "pending" || r.status === "failed" ? (
                      <Form method="post">
                        <input type="hidden" name="requestId" value={r.id} />
                        <s-button type="submit">Run now</s-button>
                      </Form>
                    ) : null}
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-section>
        );
      })}
    </s-page>
  );
}
