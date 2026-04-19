/**
 * See: docs/platform-admin-spec.md §12 (aggregate metrics)
 * Charts ship later with a lib — MVP surfaces the numbers as a table.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { requireAdminSession } from "~/lib/admin-auth.server.js";
import prisma from "~/db.server.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const now = Date.now();
  const since7d = new Date(now - 7 * DAY_MS);
  const since30d = new Date(now - 30 * DAY_MS);

  const [
    installs7d,
    uninstalls7d,
    installs30d,
    redemptionsTotal,
    flaggedTotal,
    dismissedFlagged,
  ] = await Promise.all([
    prisma.shop.count({ where: { installedAt: { gte: since7d } } }),
    prisma.shop.count({
      where: { uninstalledAt: { gte: since7d, not: null } },
    }),
    prisma.shop.count({ where: { installedAt: { gte: since30d } } }),
    prisma.redemptionRecord.count({
      where: { createdAt: { gte: since30d } },
    }),
    prisma.flaggedOrder.count({ where: { createdAt: { gte: since30d } } }),
    prisma.flaggedOrder.count({
      where: {
        createdAt: { gte: since30d },
        merchantAction: "dismissed",
      },
    }),
  ]);

  const falsePositiveRate =
    flaggedTotal === 0
      ? 0
      : Math.round((dismissedFlagged / flaggedTotal) * 1000) / 10;

  return {
    metrics: {
      installs7d,
      uninstalls7d,
      installs30d,
      redemptions30d: redemptionsTotal,
      flagged30d: flaggedTotal,
      dismissedFlagged30d: dismissedFlagged,
      falsePositiveRatePercent: falsePositiveRate,
    },
  };
};

export default function AdminMetrics() {
  const { metrics } = useLoaderData<typeof loader>();

  const rows: Array<[string, string | number]> = [
    ["Installs — last 7d", metrics.installs7d],
    ["Uninstalls — last 7d", metrics.uninstalls7d],
    ["Installs — last 30d", metrics.installs30d],
    ["Redemptions — last 30d", metrics.redemptions30d.toLocaleString()],
    ["Flagged — last 30d", metrics.flagged30d.toLocaleString()],
    [
      "Dismissed (merchant-determined FP) — last 30d",
      metrics.dismissedFlagged30d.toLocaleString(),
    ],
    [
      "False-positive rate",
      `${metrics.falsePositiveRatePercent.toFixed(1)}%`,
    ],
  ];

  return (
    <s-page heading="Metrics">
      <s-section heading="Last 30 days — cross-shop totals">
        <s-table>
          <s-table-header-row>
            <s-table-header>Metric</s-table-header>
            <s-table-header>Value</s-table-header>
          </s-table-header-row>
          {rows.map(([k, v]) => (
            <s-table-row key={k}>
              <s-table-cell>{k}</s-table-cell>
              <s-table-cell>{v}</s-table-cell>
            </s-table-row>
          ))}
        </s-table>
      </s-section>
      <s-section>
        <s-text color="subdued">
          Charts (line / histogram) ship post-MVP. Query this data via the DB
          directly until then.
        </s-text>
      </s-section>
    </s-page>
  );
}
