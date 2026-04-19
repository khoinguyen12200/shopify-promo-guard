/**
 * See: docs/platform-admin-spec.md §9 (job queue visibility)
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";

import { requireAdminSession } from "~/lib/admin-auth.server.js";
import prisma from "~/db.server.js";

const STATUSES = ["all", "pending", "running", "failed", "done"] as const;
type StatusFilter = (typeof STATUSES)[number];

function isStatusFilter(x: string): x is StatusFilter {
  return (STATUSES as readonly string[]).includes(x);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status") ?? "all";
  const status = isStatusFilter(rawStatus) ? rawStatus : "all";
  const typeFilter = url.searchParams.get("type") ?? "";

  const where: {
    status?: string;
    type?: { contains: string };
  } = {};
  if (status !== "all") where.status = status;
  if (typeFilter) where.type = { contains: typeFilter };

  const [jobs, pending, running, failed, deadLetters] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        createdAt: true,
        shop: { select: { shopDomain: true } },
      },
    }),
    prisma.job.count({ where: { status: "pending" } }),
    prisma.job.count({ where: { status: "running" } }),
    prisma.job.count({
      where: { status: "failed", attempts: { lt: 5 } },
    }),
    prisma.job.count({
      where: { status: "failed", attempts: { gte: 5 } },
    }),
  ]);

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      shopDomain: j.shop.shopDomain,
      createdAt: j.createdAt.toISOString(),
    })),
    depth: { pending, running, failed, deadLetters },
    filters: { status, type: typeFilter },
  };
};

function age(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export default function AdminJobs() {
  const { jobs, depth, filters } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  function onStatus(value: string) {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("status");
    else next.set("status", value);
    setParams(next);
  }

  return (
    <s-page heading="Jobs">
      <s-section>
        <s-stack direction="inline" gap="base">
          {STATUSES.map((s) => (
            <s-button
              key={s}
              variant={filters.status === s ? "primary" : "secondary"}
              onClick={() => onStatus(s)}
            >
              {s}
            </s-button>
          ))}
        </s-stack>
        <s-text color="subdued">
          Depth: {depth.pending} pending · {depth.running} running ·{" "}
          {depth.failed} failed needing retry · {depth.deadLetters} dead
        </s-text>
      </s-section>

      <s-section>
        {jobs.length === 0 ? (
          <s-text color="subdued">No jobs match the current filter.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>id</s-table-header>
              <s-table-header>type</s-table-header>
              <s-table-header>shop</s-table-header>
              <s-table-header>status</s-table-header>
              <s-table-header>attempts</s-table-header>
              <s-table-header>age</s-table-header>
            </s-table-header-row>
            {jobs.map((j) => (
              <s-table-row key={j.id}>
                <s-table-cell>{j.id.slice(0, 10)}</s-table-cell>
                <s-table-cell>{j.type}</s-table-cell>
                <s-table-cell>{j.shopDomain}</s-table-cell>
                <s-table-cell>{j.status}</s-table-cell>
                <s-table-cell>{j.attempts}</s-table-cell>
                <s-table-cell>{age(j.createdAt)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
