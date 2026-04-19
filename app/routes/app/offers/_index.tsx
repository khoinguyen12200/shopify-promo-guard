/**
 * See: docs/admin-ui-spec.md §4 (Offers list)
 * Standard: docs/polaris-standards.md §13 (Index-table pattern),
 *           §2 (Page primary-action slot)
 */
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";

import {
  ActivationNudge,
  type ActivationNudgeOffer,
} from "~/components/activation-nudge";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

type OfferRow = {
  id: string;
  name: string;
  status: string;
  mode: string;
  validationFunctionActivated: boolean;
  codeCount: number;
  redemptions: number;
  flagged: number;
};

function statusBadge(offer: {
  status: string;
  mode: string;
  validationFunctionActivated: boolean;
}): { tone: "success" | "warning" | "neutral" | "info"; label: string } {
  if (
    offer.status === "active" &&
    offer.mode === "block" &&
    !offer.validationFunctionActivated
  ) {
    return { tone: "warning", label: "Needs activation" };
  }
  if (offer.status === "active") return { tone: "success", label: "Active" };
  if (offer.status === "paused") return { tone: "neutral", label: "Paused" };
  return { tone: "info", label: "Draft" };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }
  const offers = await prisma.protectedOffer.findMany({
    where: { shopId: shop.id, archivedAt: null },
    include: { _count: { select: { codes: true } } },
    orderBy: { createdAt: "desc" },
  });

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const offerIds = offers.map((o) => o.id);

  const [redemptionGroups, flaggedGroups, pendingFlaggedCount] =
    await Promise.all([
      offerIds.length
        ? prisma.redemptionRecord.groupBy({
            by: ["protectedOfferId"],
            where: {
              protectedOfferId: { in: offerIds },
              createdAt: { gte: since },
            },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{
            protectedOfferId: string;
            _count: { _all: number };
          }>),
      offerIds.length
        ? prisma.flaggedOrder.groupBy({
            by: ["protectedOfferId"],
            where: {
              protectedOfferId: { in: offerIds },
              createdAt: { gte: since },
            },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{
            protectedOfferId: string;
            _count: { _all: number };
          }>),
      prisma.flaggedOrder.count({
        where: { shopId: shop.id, merchantAction: "pending" },
      }),
    ]);

  const redemptionsByOffer = new Map<string, number>();
  for (const row of redemptionGroups) {
    redemptionsByOffer.set(row.protectedOfferId, row._count._all);
  }
  const flaggedByOffer = new Map<string, number>();
  for (const row of flaggedGroups) {
    flaggedByOffer.set(row.protectedOfferId, row._count._all);
  }

  const rows: OfferRow[] = offers.map((o) => ({
    id: o.id,
    name: o.name,
    status: o.status,
    mode: o.mode,
    validationFunctionActivated: o.validationFunctionActivated,
    codeCount: o._count.codes,
    redemptions: redemptionsByOffer.get(o.id) ?? 0,
    flagged: flaggedByOffer.get(o.id) ?? 0,
  }));

  const nudges: ActivationNudgeOffer[] = offers
    .filter(
      (o) =>
        o.status === "active" &&
        o.mode === "block" &&
        !o.validationFunctionActivated,
    )
    .map((o) => ({ id: o.id, name: o.name, shopDomain: session.shop }));

  return { rows, nudges, pendingFlaggedCount };
};

export default function OffersIndex() {
  const { rows, nudges, pendingFlaggedCount } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Offers">
      <s-button slot="primary-action" variant="primary" href="/app/offers/new">
        Create offer
      </s-button>

      {nudges.length > 0
        ? nudges.map((offer) => (
            <ActivationNudge key={offer.id} offer={offer} />
          ))
        : null}

      {pendingFlaggedCount > 0 ? (
        <s-banner tone="info">
          <s-paragraph>
            {pendingFlaggedCount} order
            {pendingFlaggedCount === 1 ? "" : "s"} need
            {pendingFlaggedCount === 1 ? "s" : ""} your review.
          </s-paragraph>
          <s-button slot="action" href="/app/flagged">
            Review flagged
          </s-button>
        </s-banner>
      ) : null}

      {rows.length === 0 ? (
        <s-section heading="Protect your first welcome offer">
          <s-stack gap="base">
            <s-paragraph>
              Protect your welcome discount so it can only be used once per
              customer — even if they try a new email.
            </s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button variant="primary" href="/app/offers/new">
                Create your first protected offer
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none" accessibilityLabel="Protected offers">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header format="numeric">Codes</s-table-header>
              <s-table-header format="numeric">
                Redemptions (30d)
              </s-table-header>
              <s-table-header format="numeric">Flagged (30d)</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => {
                const badge = statusBadge(r);
                return (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-link href={`/app/offers/${r.id}`}>{r.name}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={badge.tone}>{badge.label}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {r.codeCount.toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>
                      {r.redemptions.toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>{r.flagged.toLocaleString()}</s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
