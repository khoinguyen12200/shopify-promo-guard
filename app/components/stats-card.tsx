/**
 * See: docs/admin-ui-spec.md §6 (Offer detail — last 30 days stats)
 * Standard: docs/polaris-standards.md §11 (Metrics card)
 *
 * Label is semantic <s-heading>, value is <s-text>. A trailing paragraph
 * (optional) describes what the metric represents.
 */

export type StatsCardProps = {
  heading: string;
  value: number | string;
  sublabel?: string;
};

export function StatsCard({ heading, value, sublabel }: StatsCardProps) {
  const display =
    typeof value === "number" ? value.toLocaleString() : value;

  return (
    <s-box
      padding="base"
      background="base"
      borderRadius="base"
      borderWidth="base"
      borderColor="base"
    >
      <s-grid gap="small-300">
        <s-heading>{heading}</s-heading>
        <s-text>{display}</s-text>
        {sublabel ? (
          <s-paragraph color="subdued">{sublabel}</s-paragraph>
        ) : null}
      </s-grid>
    </s-box>
  );
}
