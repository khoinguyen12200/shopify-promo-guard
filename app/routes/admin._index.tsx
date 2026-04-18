/**
 * See: docs/platform-admin-spec.md §4 (dashboard)
 * Related: docs/platform-admin-spec.md §19 (performance / scale)
 */

import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { requireAdminSession } from "../lib/admin-auth.server.js";
import prisma from "../db.server.js";
import { DashboardCard } from "../components/admin/dashboard-card.js";

type DashboardNumbers = {
  // Last 24 hours
  installs24h: number;
  uninstalls24h: number;
  paidRedemptions24h: number;
  postOrderFlagged24h: number;
  // Health
  jobsPending: number;
  jobsRunning: number;
  jobsProcessedLastHour: number;
  deadLetters: number;
  webhookFailures24h: number;
  // Compliance queue
  pendingDataRequests: number;
  pendingCustomerRedacts: number;
  pendingShopRedacts: number;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sinceHour = new Date(now.getTime() - 60 * 60 * 1000);

  const [
    installs24h,
    uninstalls24h,
    paidRedemptions24h,
    postOrderFlagged24h,
    jobsPending,
    jobsRunning,
    jobsProcessedLastHour,
    deadLetters,
    webhookFailures24h,
    pendingDataRequests,
    pendingCustomerRedacts,
    pendingShopRedacts,
  ] = await Promise.all([
    prisma.shop.count({ where: { installedAt: { gte: since24h } } }),
    prisma.shop.count({ where: { uninstalledAt: { gte: since24h } } }),
    prisma.redemptionRecord.count({ where: { createdAt: { gte: since24h } } }),
    prisma.flaggedOrder.count({ where: { createdAt: { gte: since24h } } }),
    prisma.job.count({ where: { status: "pending" } }),
    prisma.job.count({ where: { status: "running" } }),
    prisma.job.count({
      where: { status: "complete", completedAt: { gte: sinceHour } },
    }),
    prisma.job.count({ where: { status: "failed" } }),
    prisma.webhookEvent.count({
      where: { status: "failed", receivedAt: { gte: since24h } },
    }),
    prisma.complianceRequest.count({
      where: { topic: "customers/data_request", status: "pending" },
    }),
    prisma.complianceRequest.count({
      where: { topic: "customers/redact", status: "pending" },
    }),
    prisma.complianceRequest.count({
      where: { topic: "shop/redact", status: "pending" },
    }),
  ]);

  const numbers: DashboardNumbers = {
    installs24h,
    uninstalls24h,
    paidRedemptions24h,
    postOrderFlagged24h,
    jobsPending,
    jobsRunning,
    jobsProcessedLastHour,
    deadLetters,
    webhookFailures24h,
    pendingDataRequests,
    pendingCustomerRedacts,
    pendingShopRedacts,
  };

  return { numbers, generatedAt: now.toISOString() };
};

export default function AdminDashboard() {
  const { numbers, generatedAt } = useLoaderData<typeof loader>();

  return (
    <div>
      <header className="pg-page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Generated {new Date(generatedAt).toLocaleString()}</p>
        </div>
      </header>

      <section className="pg-section">
        <h2>Last 24 hours</h2>
        <div className="pg-grid">
          <DashboardCard label="Installs" value={numbers.installs24h} />
          <DashboardCard label="Uninstalls" value={numbers.uninstalls24h} />
          <DashboardCard
            label="Paid redemptions processed"
            value={numbers.paidRedemptions24h}
          />
          <DashboardCard
            label="Post-order flagged"
            value={numbers.postOrderFlagged24h}
          />
          <DashboardCard
            label="Webhook failures"
            value={numbers.webhookFailures24h}
            emphasise={numbers.webhookFailures24h > 0}
          />
          <DashboardCard
            label="Dead-letter jobs"
            value={numbers.deadLetters}
            emphasise={numbers.deadLetters > 0}
          />
        </div>
      </section>

      <section className="pg-section">
        <h2>Health</h2>
        <div className="pg-grid">
          <DashboardCard
            label="Job queue — pending"
            value={numbers.jobsPending}
          />
          <DashboardCard
            label="Job queue — running"
            value={numbers.jobsRunning}
          />
          <DashboardCard
            label="Jobs processed (last hour)"
            value={numbers.jobsProcessedLastHour}
          />
        </div>
      </section>

      <section className="pg-section">
        <h2>Compliance queue</h2>
        <div className="pg-grid">
          <DashboardCard
            label="Pending data_request"
            value={numbers.pendingDataRequests}
            emphasise={numbers.pendingDataRequests > 0}
          />
          <DashboardCard
            label="Pending customer redact"
            value={numbers.pendingCustomerRedacts}
            emphasise={numbers.pendingCustomerRedacts > 0}
          />
          <DashboardCard
            label="Pending shop redact"
            value={numbers.pendingShopRedacts}
            emphasise={numbers.pendingShopRedacts > 0}
          />
        </div>
      </section>

      <section className="pg-section">
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <Link to="/admin/dead-letters" className="pg-link">
            Jump to dead-letters →
          </Link>
          <Link to="/admin/compliance" className="pg-link">
            Jump to compliance →
          </Link>
          <Link to="/admin/shops" className="pg-link">
            Browse shops →
          </Link>
        </div>
      </section>
    </div>
  );
}
