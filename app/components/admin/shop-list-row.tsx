/**
 * See: docs/platform-admin-spec.md §5 (shops list row)
 * Related: docs/platform-admin-spec.md §6 (shop detail link target)
 */

import { Link } from "react-router";

export interface ShopListRowData {
  id: string;
  shopDomain: string;
  installedAt: string;
  uninstalledAt: string | null;
  protectedDataLevel: number;
  offerCount: number;
  redemptionCount: number;
  flagCount: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // Short, unambiguous form for ops use: "Apr 15 2026".
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function ShopListRow({ shop }: { shop: ShopListRowData }) {
  const isActive = shop.uninstalledAt === null;

  return (
    <Link
      to={`/admin/shops/${shop.id}`}
      style={rowStyle}
      prefetch="intent"
    >
      <span style={shopCellStyle}>
        <span style={domainStyle}>{shop.shopDomain}</span>
        <span style={tagsStyle}>
          {isActive ? (
            <span style={{ ...tagStyle, color: "#8fd18f" }}>active</span>
          ) : (
            <span style={{ ...tagStyle, color: "#f88" }}>uninstalled</span>
          )}
          {shop.protectedDataLevel > 0 ? (
            <span style={tagStyle}>L{shop.protectedDataLevel}</span>
          ) : null}
        </span>
      </span>
      <span style={numCellStyle}>{formatDate(shop.installedAt)}</span>
      <span style={numCellStyle}>{formatDate(shop.uninstalledAt)}</span>
      <span style={numCellStyle}>{shop.offerCount}</span>
      <span style={numCellStyle}>{shop.redemptionCount.toLocaleString()}</span>
      <span style={numCellStyle}>{shop.flagCount.toLocaleString()}</span>
    </Link>
  );
}

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2fr 1fr 1fr 0.6fr 1fr 0.8fr",
  padding: "10px 12px",
  borderBottom: "1px solid #2a2a40",
  color: "#eee",
  textDecoration: "none",
  fontSize: "13px",
  alignItems: "center",
};

const shopCellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  minWidth: 0,
};

const domainStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tagsStyle: React.CSSProperties = {
  display: "flex",
  gap: "6px",
};

const tagStyle: React.CSSProperties = {
  fontSize: "10px",
  color: "#aaa",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const numCellStyle: React.CSSProperties = {
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
