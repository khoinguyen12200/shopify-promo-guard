/**
 * See: docs/platform-admin-spec.md §5 (shops list)
 * Related: docs/platform-admin-spec.md §6 (shop detail linked from here)
 */

import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import { requireAdminSession } from "../lib/admin-auth.server.js";
import prisma from "../db.server.js";
import { ShopListRow } from "../components/admin/shop-list-row.js";

const PAGE_SIZE = 25;

type FilterKey = "all" | "active" | "uninstalling" | "redacted";
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "uninstalling", label: "Uninstalled < 48h" },
  { key: "redacted", label: "Uninstalled + redacted" },
];

type SortKey = "installed" | "uninstalled" | "redemptions" | "flags";
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "installed", label: "Install date" },
  { key: "uninstalled", label: "Uninstall date" },
  { key: "redemptions", label: "Redemptions" },
  { key: "flags", label: "Flags" },
];

function parseFilter(raw: string | null): FilterKey {
  if (raw === "active" || raw === "uninstalling" || raw === "redacted") {
    return raw;
  }
  return "all";
}

function parseSort(raw: string | null): SortKey {
  if (
    raw === "installed" ||
    raw === "uninstalled" ||
    raw === "redemptions" ||
    raw === "flags"
  ) {
    return raw;
  }
  return "installed";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const filter = parseFilter(url.searchParams.get("filter"));
  const sort = parseSort(url.searchParams.get("sort"));
  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const now = new Date();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const where: {
    shopDomain?: { contains: string; mode: "insensitive" };
    uninstalledAt?: Date | { gte?: Date; lt?: Date } | null;
  } = {};

  if (search) {
    where.shopDomain = { contains: search, mode: "insensitive" };
  }

  if (filter === "active") {
    where.uninstalledAt = null;
  } else if (filter === "uninstalling") {
    where.uninstalledAt = { gte: fortyEightHoursAgo };
  } else if (filter === "redacted") {
    where.uninstalledAt = { lt: fortyEightHoursAgo };
  }

  // For counts we do a fast server-side sort; for redemptions/flags we need to
  // aggregate after fetching. We pull a bounded page window either way.
  const [total, shops] = await Promise.all([
    prisma.shop.count({ where }),
    prisma.shop.findMany({
      where,
      orderBy:
        sort === "uninstalled"
          ? { uninstalledAt: "desc" }
          : { installedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        shopDomain: true,
        installedAt: true,
        uninstalledAt: true,
        protectedDataLevel: true,
        _count: {
          select: {
            protectedOffers: true,
            redemptionRecords: true,
            flaggedOrders: true,
          },
        },
      },
    }),
  ]);

  // Secondary in-memory sort for count-based sorts (operates on the page).
  let rows = shops;
  if (sort === "redemptions") {
    rows = [...shops].sort(
      (a, b) => b._count.redemptionRecords - a._count.redemptionRecords,
    );
  } else if (sort === "flags") {
    rows = [...shops].sort(
      (a, b) => b._count.flaggedOrders - a._count.flaggedOrders,
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return {
    rows: rows.map((s) => ({
      id: s.id,
      shopDomain: s.shopDomain,
      installedAt: s.installedAt.toISOString(),
      uninstalledAt: s.uninstalledAt ? s.uninstalledAt.toISOString() : null,
      protectedDataLevel: s.protectedDataLevel,
      offerCount: s._count.protectedOffers,
      redemptionCount: s._count.redemptionRecords,
      flagCount: s._count.flaggedOrders,
    })),
    total,
    page,
    pageCount,
    search,
    filter,
    sort,
  };
};

export default function AdminShopsIndex() {
  const { rows, total, page, pageCount, search, filter, sort } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const buildHref = (overrides: Record<string, string>): string => {
    const params = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === "") params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/admin/shops?${qs}` : "/admin/shops";
  };

  const start = rows.length === 0 ? 0 : (page - 1) * 25 + 1;
  const end = (page - 1) * 25 + rows.length;

  return (
    <div>
      <header style={headerStyle}>
        <h1 style={h1Style}>Shops</h1>
        <span style={subtleStyle}>
          {total === 0
            ? "0 shops"
            : `Showing ${start}–${end} of ${total.toLocaleString()}`}
        </span>
      </header>

      <Form method="get" style={formStyle}>
        <input
          type="text"
          name="q"
          defaultValue={search}
          placeholder="Search shop domain…"
          style={inputStyle}
        />
        <select name="filter" defaultValue={filter} style={selectStyle}>
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <select name="sort" defaultValue={sort} style={selectStyle}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              Sort: {s.label}
            </option>
          ))}
        </select>
        <button type="submit" style={buttonStyle}>
          Apply
        </button>
      </Form>

      <div style={tableStyle}>
        <div style={tableHeaderStyle}>
          <span style={colShop}>Shop</span>
          <span style={colNum}>Installed</span>
          <span style={colNum}>Uninstalled</span>
          <span style={colNum}>Offers</span>
          <span style={colNum}>Redemptions</span>
          <span style={colNum}>Flags</span>
        </div>
        {rows.length === 0 ? (
          <div style={emptyStyle}>No shops match these filters.</div>
        ) : (
          rows.map((row) => <ShopListRow key={row.id} shop={row} />)
        )}
      </div>

      {pageCount > 1 ? (
        <nav style={paginationStyle} aria-label="Pagination">
          {page > 1 ? (
            <Link to={buildHref({ page: String(page - 1) })} style={pageLink}>
              ← Previous
            </Link>
          ) : (
            <span style={{ ...pageLink, color: "#555" }}>← Previous</span>
          )}
          <span style={subtleStyle}>
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link to={buildHref({ page: String(page + 1) })} style={pageLink}>
              Next →
            </Link>
          ) : (
            <span style={{ ...pageLink, color: "#555" }}>Next →</span>
          )}
        </nav>
      ) : null}
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "16px",
};

const h1Style: React.CSSProperties = {
  color: "#f0c040",
  margin: 0,
  fontSize: "20px",
};

const subtleStyle: React.CSSProperties = {
  color: "#888",
  fontSize: "12px",
};

const formStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  marginBottom: "16px",
  flexWrap: "wrap",
};

const inputStyle: React.CSSProperties = {
  flex: "1 1 240px",
  minWidth: "200px",
  padding: "6px 8px",
  background: "#0f0f1a",
  border: "1px solid #444",
  color: "#eee",
  fontFamily: "monospace",
  fontSize: "13px",
};

const selectStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "#0f0f1a",
  border: "1px solid #444",
  color: "#eee",
  fontFamily: "monospace",
  fontSize: "13px",
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "#f0c040",
  color: "#1a1a2e",
  border: "none",
  fontFamily: "monospace",
  fontSize: "13px",
  fontWeight: "bold",
  cursor: "pointer",
};

const tableStyle: React.CSSProperties = {
  border: "1px solid #2a2a40",
  borderRadius: "4px",
  background: "#1a1a2e",
  overflow: "hidden",
};

const tableHeaderStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2fr 1fr 1fr 0.6fr 1fr 0.8fr",
  padding: "8px 12px",
  background: "#0f0f1a",
  color: "#888",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  borderBottom: "1px solid #2a2a40",
};

const colShop: React.CSSProperties = {};
const colNum: React.CSSProperties = { textAlign: "right" };

const emptyStyle: React.CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "#888",
};

const paginationStyle: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  alignItems: "center",
  justifyContent: "center",
  marginTop: "16px",
};

const pageLink: React.CSSProperties = {
  color: "#f0c040",
  textDecoration: "none",
  fontSize: "13px",
};
