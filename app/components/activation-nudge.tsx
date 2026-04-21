/**
 * See: docs/admin-ui-spec.md §4 (Offers list — "Needs activation" nudge)
 * Standard: docs/polaris-standards.md §8 (Banner), §9 (Stack vs Grid)
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
        <s-paragraph>
          Your Checkout Rule isn&apos;t turned on yet. Your offer isn&apos;t
          being protected — abusers can still redeem it.
        </s-paragraph>
        <s-stack direction="inline" gap="small-300">
          <s-button variant="primary" href={rulesUrl} target="_blank">
            Open Checkout Rules
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
