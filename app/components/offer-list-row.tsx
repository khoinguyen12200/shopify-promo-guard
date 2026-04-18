/**
 * See: docs/admin-ui-spec.md §4 (Offers list — row)
 */

export type OfferListRowOffer = {
  id: string;
  name: string;
  status: string;
  mode: string;
  validationFunctionActivated: boolean;
  codeCount: number;
};

export type OfferListRowMetrics = {
  redemptions: number;
  blocked: number;
  flagged: number;
};

export type OfferListRowProps = {
  offer: OfferListRowOffer;
  metrics: OfferListRowMetrics;
};

function statusBadge(offer: OfferListRowOffer) {
  if (
    offer.status === "active" &&
    offer.mode === "block" &&
    !offer.validationFunctionActivated
  ) {
    return { tone: "warning" as const, label: "Needs activation" };
  }
  if (offer.status === "active") {
    return { tone: "success" as const, label: "Active" };
  }
  if (offer.status === "paused") {
    return { tone: "neutral" as const, label: "Paused" };
  }
  return { tone: "info" as const, label: "Draft" };
}

export function OfferListRow({ offer, metrics }: OfferListRowProps) {
  const badge = statusBadge(offer);
  const href = `/app/offers/${offer.id}`;
  return (
    <s-stack gap="small">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-heading>
          <a href={href}>{offer.name}</a>
        </s-heading>
        <s-badge tone={badge.tone}>{badge.label}</s-badge>
      </s-stack>
      <s-text color="subdued">
        {offer.codeCount === 1 ? "1 code" : `${offer.codeCount} codes`}
      </s-text>
      <s-text>
        {metrics.redemptions} redemptions this month · {metrics.blocked} blocked
        · {metrics.flagged} flagged
      </s-text>
    </s-stack>
  );
}
