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
      <header style={headerStyle}>
        <h1 style={h1Style}>Dashboard</h1>
        <span style={timestampStyle}>
          Generated {new Date(generatedAt).toLocaleString()}
        </span>
      </header>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Last 24 hours</h2>
        <div style={gridStyle}>
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
            label="Webhook failures (24h)"
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

      <section style={sectionStyle}>
        <h2 style={h2Style}>Health</h2>
        <div style={gridStyle}>
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

      <section style={sectionStyle}>
        <h2 style={h2Style}>Compliance queue</h2>
        <div style={gridStyle}>
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

      <section style={sectionStyle}>
        <div style={linkRowStyle}>
          <Link to="/admin/dead-letters" style={linkStyle}>
            Jump to dead-letters →
          </Link>
          <Link to="/admin/compliance" style={linkStyle}>
            Jump to compliance →
          </Link>
          <Link to="/admin/shops" style={linkStyle}>
            Browse shops →
          </Link>
        </div>
      </section>
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "24px",
};

const h1Style: React.CSSProperties = {
  color: "#f0c040",
  margin: 0,
  fontSize: "20px",
};

const h2Style: React.CSSProperties = {
  color: "#ccc",
  fontSize: "14px",
  margin: "0 0 8px 0",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const timestampStyle: React.CSSProperties = {
  color: "#888",
  fontSize: "12px",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: "24px",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: "12px",
};

const linkRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  flexWrap: "wrap",
};

const linkStyle: React.CSSProperties = {
  color: "#f0c040",
  textDecoration: "none",
  fontSize: "14px",
};
