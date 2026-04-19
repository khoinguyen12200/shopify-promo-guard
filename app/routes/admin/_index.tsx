/**
 * See: docs/platform-admin-spec.md §4 (dashboard)
 * Related: docs/platform-admin-spec.md §19 (performance / scale)
 */

import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { requireAdminSession } from "~/lib/admin-auth.server.js";
import prisma from "~/db.server.js";

type DashboardNumbers = {
  installs24h: number;
  uninstalls24h: number;
  paidRedemptions24h: number;
  postOrderFlagged24h: number;
  jobsPending: number;
  jobsRunning: number;
  jobsProcessedLastHour: number;
  deadLetters: number;
  webhookFailures24h: number;
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

function Metric({
  label,
  value,
  emphasise,
}: {
  label: string;
  value: number;
  emphasise?: boolean;
}) {
  return (
    <s-box
      padding="base"
      background="base"
      borderRadius="base"
      borderWidth="base"
      borderColor="base"
    >
      <s-grid gap="small-300">
        <s-heading>{label}</s-heading>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text>{value.toLocaleString()}</s-text>
          {emphasise ? <s-badge tone="critical">attention</s-badge> : null}
        </s-stack>
      </s-grid>
    </s-box>
  );
}

export default function AdminDashboard() {
  const { numbers, generatedAt } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Dashboard" inlineSize="large">
      <s-section
        heading="Last 24 hours"
        accessibilityLabel="Last 24 hour activity metrics"
      >
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Generated {new Date(generatedAt).toLocaleString()}
          </s-paragraph>
          <s-grid
            gap="base"
            gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
          >
            <Metric label="Installs" value={numbers.installs24h} />
            <Metric label="Uninstalls" value={numbers.uninstalls24h} />
            <Metric
              label="Paid redemptions"
              value={numbers.paidRedemptions24h}
            />
            <Metric
              label="Post-order flagged"
              value={numbers.postOrderFlagged24h}
            />
            <Metric
              label="Webhook failures"
              value={numbers.webhookFailures24h}
              emphasise={numbers.webhookFailures24h > 0}
            />
            <Metric
              label="Dead-letter jobs"
              value={numbers.deadLetters}
              emphasise={numbers.deadLetters > 0}
            />
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Health" accessibilityLabel="Job queue health">
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
        >
          <Metric label="Job queue — pending" value={numbers.jobsPending} />
          <Metric label="Job queue — running" value={numbers.jobsRunning} />
          <Metric
            label="Jobs processed (last hour)"
            value={numbers.jobsProcessedLastHour}
          />
        </s-grid>
      </s-section>

      <s-section
        heading="Compliance queue"
        accessibilityLabel="Pending GDPR compliance requests"
      >
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
        >
          <Metric
            label="Pending data_request"
            value={numbers.pendingDataRequests}
            emphasise={numbers.pendingDataRequests > 0}
          />
          <Metric
            label="Pending customer redact"
            value={numbers.pendingCustomerRedacts}
            emphasise={numbers.pendingCustomerRedacts > 0}
          />
          <Metric
            label="Pending shop redact"
            value={numbers.pendingShopRedacts}
            emphasise={numbers.pendingShopRedacts > 0}
          />
        </s-grid>
      </s-section>

      <s-section
        heading="Shortcuts"
        accessibilityLabel="Quick links to operational pages"
      >
        <s-stack direction="inline" gap="base">
          <s-link href="/admin/dead-letters">Jump to dead-letters</s-link>
          <s-link href="/admin/compliance">Jump to compliance</s-link>
          <s-link href="/admin/shops">Browse shops</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
