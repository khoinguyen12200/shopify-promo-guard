/**
 * See: docs/admin-ui-spec.md §4 (Offers list — "Needs activation" nudge)
 */

export type ActivationNudgeOffer = {
  id: string;
  name: string;
  shopDomain: string;
};

export type ActivationNudgeProps = {
  offer: ActivationNudgeOffer;
};

export function ActivationNudge({ offer }: ActivationNudgeProps) {
  const rulesUrl = `https://admin.shopify.com/store/${offer.shopDomain}/settings/checkout/rules`;
  return (
    <s-banner tone="warning" heading={`${offer.name} — needs activation`}>
      <s-stack gap="base">
        <s-text>
          You chose Block mode, but the Checkout Rule isn&apos;t turned on yet.
          Your offer isn&apos;t being protected.
        </s-text>
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" href={rulesUrl} target="_blank">
            Open Checkout Rules
          </s-button>
          <s-button href={`/app/offers/${offer.id}/edit`}>
            Switch to silent mode
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
