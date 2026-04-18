/**
 * See: docs/admin-ui-spec.md §7 (Flagged orders page)
 * Related: docs/database-design.md (FlaggedOrder model)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";

import {
  FlaggedOrderRow,
  type FlaggedOrderRowOrder,
} from "../components/flagged-order-row";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

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
  const { rows, filter, offerId, offers, shopDomain } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const buildFilterHref = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("filter", next);
    return `/app/flagged?${params.toString()}`;
  };

  const buildOfferHref = (nextOfferId: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (nextOfferId) {
      params.set("offerId", nextOfferId);
    } else {
      params.delete("offerId");
    }
    return `/app/flagged?${params.toString()}`;
  };

  const activeOffer = offerId
    ? offers.find((o) => o.id === offerId) ?? null
    : null;

  return (
    <s-page heading="Flagged orders">
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          {FILTERS.map((f) => (
            <s-button
              key={f.value}
              href={buildFilterHref(f.value)}
              variant={f.value === filter ? "primary" : undefined}
            >
              {f.label}
            </s-button>
          ))}
        </s-stack>
      </s-section>

      {offers.length > 0 ? (
        <s-section>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text color="subdued">Offer:</s-text>
            <s-button
              href={buildOfferHref(null)}
              variant={!offerId ? "primary" : undefined}
            >
              All offers
            </s-button>
            {offers.map((o) => (
              <s-button
                key={o.id}
                href={buildOfferHref(o.id)}
                variant={o.id === offerId ? "primary" : undefined}
              >
                {o.name}
              </s-button>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {rows.length === 0 ? (
        <s-section heading="No flagged orders yet">
          <s-stack gap="base">
            <s-text>
              Orders get flagged when they match a prior redemption of a
              protected offer. You&apos;ll see them here for review.
            </s-text>
          </s-stack>
        </s-section>
      ) : (
        <s-section
          heading={
            activeOffer
              ? `Flagged for ${activeOffer.name}`
              : "Flagged orders"
          }
        >
          <s-stack gap="large">
            {rows.map((order) => (
              <FlaggedOrderRow
                key={order.id}
                order={order}
                shopDomain={shopDomain}
              />
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
