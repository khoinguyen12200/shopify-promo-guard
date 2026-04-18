/**
 * See: docs/admin-ui-spec.md §6 (Offer detail — last 30 days stats)
 */

export type StatsCardProps = {
  heading: string;
  value: number | string;
  sublabel?: string;
};

export function StatsCard({ heading, value, sublabel }: StatsCardProps) {
  return (
    <s-section heading={heading}>
      <s-stack gap="small">
        <s-heading>{String(value)}</s-heading>
        {sublabel ? <s-text color="subdued">{sublabel}</s-text> : null}
      </s-stack>
    </s-section>
  );
}
