/**
 * See: docs/admin-ui-spec.md §4 (Offers list)
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import {
  ActivationNudge,
  type ActivationNudgeOffer,
} from "../components/activation-nudge";
import {
  OfferListRow,
  type OfferListRowOffer,
} from "../components/offer-list-row";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

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

  const rows = offers.map((o) => {
    const offer: OfferListRowOffer = {
      id: o.id,
      name: o.name,
      status: o.status,
      mode: o.mode,
      validationFunctionActivated: o.validationFunctionActivated,
      codeCount: o._count.codes,
    };
    const redemptions = redemptionsByOffer.get(o.id) ?? 0;
    const flagged = flaggedByOffer.get(o.id) ?? 0;
    // "blocked" is reported via flagged-order history in MVP; actual "blocked
    // at checkout" counters ship later. For now surface flagged as an upper
    // bound until a dedicated counter exists.
    const blocked = 0;
    return { offer, metrics: { redemptions, blocked, flagged } };
  });

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
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" href="/app/offers/new">
            Create offer
          </s-button>
        </s-stack>
      </s-section>

      {nudges.length > 0 ? (
        <s-section>
          <s-stack gap="base">
            {nudges.map((offer) => (
              <ActivationNudge key={offer.id} offer={offer} />
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {rows.length === 0 ? (
        <s-section heading="No protected offers yet">
          <s-stack gap="base">
            <s-text>
              Protect your welcome discount so it can only be used once per
              customer — even if they try a new email.
            </s-text>
            <s-button variant="primary" href="/app/offers/new">
              Create your first protected offer
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <s-section heading="Protected offers">
          <s-stack gap="large">
            {rows.map(({ offer, metrics }) => (
              <OfferListRow key={offer.id} offer={offer} metrics={metrics} />
            ))}
          </s-stack>
        </s-section>
      )}

      {pendingFlaggedCount > 0 ? (
        <s-section>
          <s-banner tone="info">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text>
                {pendingFlaggedCount} order
                {pendingFlaggedCount === 1 ? "" : "s"} need
                {pendingFlaggedCount === 1 ? "s" : ""} your review
              </s-text>
              <s-button href="/app/flagged">Review flagged</s-button>
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}
    </s-page>
  );
}
