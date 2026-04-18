/**
 * See: docs/platform-admin-spec.md §4 (dashboard)
 * Related: docs/platform-admin-spec.md §16 (file layout)
 */

export interface DashboardCardProps {
  label: string;
  value: number | string;
  /** When true, render the number in a warning colour. */
  emphasise?: boolean;
}

export function DashboardCard({ label, value, emphasise }: DashboardCardProps) {
  return (
    <div className="pg-card">
      <p className="pg-card__label">{label}</p>
      <p
        className="pg-card__value"
        style={emphasise ? { color: "var(--pg-critical)" } : undefined}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
