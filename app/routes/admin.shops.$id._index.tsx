/**
 * See: docs/platform-admin-spec.md §6 (shop detail)
 * Related: docs/platform-admin-spec.md §7 (PII reveal) + §8 (impersonate)
 */
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { requireAdminSession } from "../lib/admin-auth.server.js";
import prisma from "../db.server.js";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * TWENTY_FOUR_HOURS_MS;
const SEVEN_DAYS_MS = 7 * TWENTY_FOUR_HOURS_MS;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdminSession(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: {
      id: true,
      shopDomain: true,
      installedAt: true,
      uninstalledAt: true,
      scope: true,
    },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const now = Date.now();
  const since30d = new Date(now - THIRTY_DAYS_MS);
  const since7d = new Date(now - SEVEN_DAYS_MS);

  const [
    offerCount,
    offers,
    redemptions30d,
    flagged30d,
    webhookFailures7d,
  ] = await Promise.all([
    prisma.protectedOffer.count({
      where: { shopId: shop.id, archivedAt: null },
    }),
    prisma.protectedOffer.findMany({
      where: { shopId: shop.id, archivedAt: null },
      select: { id: true, name: true, status: true, mode: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.redemptionRecord.count({
      where: { shopId: shop.id, createdAt: { gte: since30d } },
    }),
    prisma.flaggedOrder.count({
      where: { shopId: shop.id, createdAt: { gte: since30d } },
    }),
    prisma.webhookEvent.count({
      where: {
        shopId: shop.id,
        receivedAt: { gte: since7d },
        status: "failed",
      },
    }),
  ]);

  return {
    shop: {
      id: shop.id,
      shopDomain: shop.shopDomain,
      installedAt: shop.installedAt.toISOString(),
      uninstalledAt: shop.uninstalledAt?.toISOString() ?? null,
      status: shop.uninstalledAt ? "Uninstalled" : "Active",
      scope: shop.scope,
    },
    overview: {
      offerCount,
      redemptions30d,
      flagged30d,
      webhookFailures7d,
    },
    offers,
  };
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ShopDetail() {
  const { shop, overview, offers } = useLoaderData<typeof loader>();
  const baseHref = `/admin/shops/${encodeURIComponent(shop.id)}`;

  return (
    <s-page heading={shop.shopDomain}>
      <s-section heading="Overview">
        <s-stack gap="small">
          <s-text>
            <strong>Installed:</strong> {formatDate(shop.installedAt)}
          </s-text>
          <s-text>
            <strong>Status:</strong> {shop.status}
            {shop.uninstalledAt
              ? ` (uninstalled ${formatDate(shop.uninstalledAt)})`
              : ""}
          </s-text>
          <s-text>
            <strong>Protected offers:</strong> {overview.offerCount}
          </s-text>
          <s-text>
            <strong>Redemptions (30d):</strong>{" "}
            {overview.redemptions30d.toLocaleString()}
          </s-text>
          <s-text>
            <strong>Flagged (30d):</strong>{" "}
            {overview.flagged30d.toLocaleString()}
          </s-text>
          <s-text>
            <strong>Webhook failures (7d):</strong>{" "}
            {overview.webhookFailures7d}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Sections">
        <s-stack direction="inline" gap="base">
          <Link to={`${baseHref}/redemptions`}>
            <s-button>Redemptions (decrypted)</s-button>
          </Link>
          <Link to={`${baseHref}/impersonate`}>
            <s-button tone="critical">Impersonate (read-only)</s-button>
          </Link>
        </s-stack>
      </s-section>

      <s-section heading="Protected offers">
        {offers.length === 0 ? (
          <s-text color="subdued">No active offers.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Mode</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            {offers.map((o) => (
              <s-table-row key={o.id}>
                <s-table-cell>{o.name}</s-table-cell>
                <s-table-cell>{o.mode}</s-table-cell>
                <s-table-cell>{o.status}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        )}
      </s-section>

      <s-section heading="OAuth scopes">
        <s-text color="subdued">{shop.scope}</s-text>
      </s-section>
    </s-page>
  );
}
