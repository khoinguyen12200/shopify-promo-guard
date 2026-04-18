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
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function ShopListRow({ shop }: { shop: ShopListRowData }) {
  const isActive = shop.uninstalledAt === null;

  return (
    <tr>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link to={`/admin/shops/${shop.id}`} className="pg-link" prefetch="intent">
            {shop.shopDomain}
          </Link>
          <span
            className={
              "pg-badge " +
              (isActive ? "pg-badge--success" : "pg-badge--critical")
            }
          >
            {isActive ? "Active" : "Uninstalled"}
          </span>
          {shop.protectedDataLevel > 0 ? (
            <span className="pg-badge">L{shop.protectedDataLevel}</span>
          ) : null}
        </div>
      </td>
      <td style={numCellStyle}>{formatDate(shop.installedAt)}</td>
      <td style={numCellStyle}>{formatDate(shop.uninstalledAt)}</td>
      <td style={numCellStyle}>{shop.offerCount}</td>
      <td style={numCellStyle}>{shop.redemptionCount.toLocaleString()}</td>
      <td style={numCellStyle}>{shop.flagCount.toLocaleString()}</td>
    </tr>
  );
}

const numCellStyle: React.CSSProperties = {
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
