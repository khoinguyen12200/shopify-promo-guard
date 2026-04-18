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
      <header className="pg-page-header">
        <div>
          <h1>Shops</h1>
          <p>
            {total === 0
              ? "0 shops"
              : `Showing ${start}–${end} of ${total.toLocaleString()}`}
          </p>
        </div>
      </header>

      <section className="pg-section">
        <Form method="get" className="pg-form-row">
          <input
            type="text"
            name="q"
            defaultValue={search}
            placeholder="Search shop domain…"
            className="pg-input"
            style={{ flex: "1 1 240px" }}
          />
          <select name="filter" defaultValue={filter} className="pg-select">
            {FILTERS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <select name="sort" defaultValue={sort} className="pg-select">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
          <button type="submit" className="pg-button pg-button--primary">
            Apply
          </button>
        </Form>
      </section>

      <section className="pg-section" style={{ padding: 0, overflow: "hidden" }}>
        <table className="pg-table">
          <thead>
            <tr>
              <th>Shop</th>
              <th style={{ textAlign: "right" }}>Installed</th>
              <th style={{ textAlign: "right" }}>Uninstalled</th>
              <th style={{ textAlign: "right" }}>Offers</th>
              <th style={{ textAlign: "right" }}>Redemptions</th>
              <th style={{ textAlign: "right" }}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: 32 }}>
                  <span className="pg-muted">
                    No shops match these filters.
                  </span>
                </td>
              </tr>
            ) : (
              rows.map((row) => <ShopListRow key={row.id} shop={row} />)
            )}
          </tbody>
        </table>
      </section>

      {pageCount > 1 ? (
        <nav
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 16,
          }}
          aria-label="Pagination"
        >
          {page > 1 ? (
            <Link to={buildHref({ page: String(page - 1) })} className="pg-link">
              ← Previous
            </Link>
          ) : (
            <span className="pg-muted">← Previous</span>
          )}
          <span className="pg-muted">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link to={buildHref({ page: String(page + 1) })} className="pg-link">
              Next →
            </Link>
          ) : (
            <span className="pg-muted">Next →</span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
