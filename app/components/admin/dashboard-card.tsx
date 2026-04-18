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
    <div style={cardStyle}>
      <div style={labelStyle}>{label}</div>
      <div
        style={{
          ...valueStyle,
          color: emphasise ? "#f88" : "#eee",
        }}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#1a1a2e",
  border: "1px solid #2a2a40",
  borderRadius: "4px",
  padding: "12px 16px",
};

const labelStyle: React.CSSProperties = {
  color: "#888",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "8px",
};

const valueStyle: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: "bold",
  fontVariantNumeric: "tabular-nums",
};
