/**
 * See: docs/platform-admin-spec.md §10 (dead-letter queue)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { requireAdminSession } from "../lib/admin-auth.server.js";
import { logAdminAction } from "../lib/admin-audit.server.js";
import prisma from "../db.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const jobs = await prisma.job.findMany({
    where: { status: "failed", attempts: { gte: 5 } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      type: true,
      error: true,
      attempts: true,
      payload: true,
      createdAt: true,
      shop: { select: { shopDomain: true } },
    },
  });

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      error: j.error,
      attempts: j.attempts,
      // Payload can contain large blobs; clip for the list view.
      payloadPreview: j.payload.slice(0, 200),
      shopDomain: j.shop.shopDomain,
      createdAt: j.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const jobId = String(form.get("jobId") ?? "");
  if (!jobId) return { error: "jobId required" };

  if (intent === "retry") {
    const updated = await prisma.job.updateMany({
      where: { id: jobId, status: "failed" },
      data: {
        status: "pending",
        attempts: 0,
        error: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (updated.count === 0) return { error: "Job not found or not failed." };
    await logAdminAction({
      adminUserId: adminUser.id,
      action: "dead_letter_retry",
      targetType: "Job",
      targetId: jobId,
    });
    return { ok: true as const, action: "retry" };
  }

  if (intent === "archive") {
    const updated = await prisma.job.updateMany({
      where: { id: jobId, status: "failed" },
      data: { status: "archived", completedAt: new Date() },
    });
    if (updated.count === 0) return { error: "Job not found." };
    await logAdminAction({
      adminUserId: adminUser.id,
      action: "dead_letter_archive",
      targetType: "Job",
      targetId: jobId,
    });
    return { ok: true as const, action: "archive" };
  }

  return { error: "Unknown intent." };
};

function age(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export default function DeadLetters() {
  const { jobs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Dead-letter jobs">
      {actionData?.error ? (
        <s-section>
          <s-banner tone="critical">{actionData.error}</s-banner>
        </s-section>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <s-section>
          <s-banner tone="success">
            Job {actionData.action === "retry" ? "re-queued" : "archived"}.
          </s-banner>
        </s-section>
      ) : null}

      {jobs.length === 0 ? (
        <s-section>
          <s-text color="subdued">
            No dead letters — everything is within retry budget.
          </s-text>
        </s-section>
      ) : (
        jobs.map((j) => (
          <s-section key={j.id}>
            <s-stack gap="small">
              <s-stack direction="inline" gap="base">
                <s-badge tone="critical">{j.type}</s-badge>
                <s-text color="subdued">
                  {j.shopDomain} · {age(j.createdAt)} ago · {j.attempts}{" "}
                  attempts
                </s-text>
              </s-stack>
              <s-text>Error: {j.error ?? "(no error recorded)"}</s-text>
              <s-text color="subdued">Payload: {j.payloadPreview}…</s-text>
              <s-stack direction="inline" gap="small">
                <Form method="post">
                  <input type="hidden" name="intent" value="retry" />
                  <input type="hidden" name="jobId" value={j.id} />
                  <s-button type="submit">Retry once more</s-button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="archive" />
                  <input type="hidden" name="jobId" value={j.id} />
                  <s-button type="submit" tone="critical">
                    Archive
                  </s-button>
                </Form>
              </s-stack>
            </s-stack>
          </s-section>
        ))
      )}
    </s-page>
  );
}
