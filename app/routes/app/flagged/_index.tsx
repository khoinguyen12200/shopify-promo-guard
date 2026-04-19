/**
 * See: docs/admin-ui-spec.md §7 (Flagged orders page)
 * Standard: docs/polaris-standards.md §13 (Index-table pattern), §9 (Stack vs Grid)
 * Related: docs/database-design.md (FlaggedOrder model)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";

import {
  FlaggedOrderRow,
  type FlaggedOrderRowOrder,
} from "~/components/flagged-order-row";
import prisma from "~/db.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

const FILTER_TO_ACTION: Record<string, string | null> = {
  all: null,
  pending: "pending",
  dismissed: "dismissed",
  cancelled: "cancelled",
};

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All" },
  { value: "dismissed", label: "Dismissed" },
  { value: "cancelled", label: "Cancelled" },
];

function parseReasons(facts: string): string[] {
  try {
    const parsed = JSON.parse(facts);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === "string" ? v : String(v)))
        .filter((v) => v.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const url = new URL(request.url);
  const rawFilter = url.searchParams.get("filter") ?? "pending";
  const filter = rawFilter in FILTER_TO_ACTION ? rawFilter : "pending";
  const offerId = url.searchParams.get("offerId");

  const merchantAction = FILTER_TO_ACTION[filter];

  const where: {
    shopId: string;
    merchantAction?: string;
    protectedOfferId?: string;
  } = { shopId: shop.id };
  if (merchantAction) where.merchantAction = merchantAction;
  if (offerId) where.protectedOfferId = offerId;

  const [flagged, offers] = await Promise.all([
    prisma.flaggedOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { protectedOffer: { select: { id: true, name: true } } },
    }),
    prisma.protectedOffer.findMany({
      where: { shopId: shop.id, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const rows: FlaggedOrderRowOrder[] = flagged.map((f) => ({
    id: f.id,
    orderGid: f.orderGid,
    orderName: f.orderName,
    riskLevel: f.riskLevel,
    score: f.score,
    reasons: parseReasons(f.facts),
    // FlaggedOrder does not store raw PII. Email surfacing requires
    // decrypting RedemptionRecord ciphertext, which is intentionally NOT
    // done here per CLAUDE.md hard rule. Keep null in MVP.
    customerEmail: null,
    merchantAction: f.merchantAction,
    createdAt: f.createdAt.toISOString(),
  }));

  return {
    rows,
    filter,
    offerId,
    offers,
    shopDomain: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const flaggedOrderId = String(formData.get("flaggedOrderId") ?? "");

  if (intent !== "dismiss" || !flaggedOrderId) {
    return { ok: false, error: "invalid_intent" };
  }

  // Scope by shop to prevent cross-shop tampering.
  const flagged = await prisma.flaggedOrder.findFirst({
    where: { id: flaggedOrderId, shopId: shop.id },
    select: { id: true },
  });
  if (!flagged) {
    return { ok: false, error: "not_found" };
  }

  await prisma.flaggedOrder.update({
    where: { id: flagged.id },
    data: {
      merchantAction: "dismissed",
      merchantActionAt: new Date(),
    },
  });

  return { ok: true };
};

export default function FlaggedOrdersIndex() {
  const { rows, filter, offerId, offers, shopDomain } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Flagged orders">
      <s-section padding="none" accessibilityLabel="Flagged orders">
        <s-box padding="base">
          <form method="get">
            <s-grid
              gap="small-200"
              gridTemplateColumns={offers.length > 0 ? "1fr 1fr auto" : "1fr auto"}
            >
              <s-select
                name="filter"
                label="Status"
                labelAccessibilityVisibility="exclusive"
                value={filter}
              >
                {FILTERS.map((f) => (
                  <s-option key={f.value} value={f.value}>
                    {f.label}
                  </s-option>
                ))}
              </s-select>
              {offers.length > 0 ? (
                <s-select
                  name="offerId"
                  label="Offer"
                  labelAccessibilityVisibility="exclusive"
                  value={offerId ?? ""}
                >
                  <s-option value="">All offers</s-option>
                  {offers.map((o) => (
                    <s-option key={o.id} value={o.id}>
                      {o.name}
                    </s-option>
                  ))}
                </s-select>
              ) : null}
              <s-button type="submit" variant="primary">
                Filter
              </s-button>
            </s-grid>
          </form>
        </s-box>

        {rows.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">
              No flagged orders match these filters. Orders get flagged when
              they match a prior redemption of a protected offer.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Risk</s-table-header>
              <s-table-header format="numeric">Score</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>When</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((order) => (
                <FlaggedOrderRow
                  key={order.id}
                  order={order}
                  shopDomain={shopDomain}
                />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
