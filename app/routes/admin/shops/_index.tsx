/**
 * See: docs/platform-admin-spec.md §5 (shops list)
 * Related: docs/platform-admin-spec.md §6 (shop detail linked from here)
 */

import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { requireAdminSession } from "~/lib/admin-auth.server.js";
import prisma from "~/db.server.js";

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
  if (raw === "active" || raw === "uninstalling" || raw === "redacted") return raw;
  return "all";
}

function parseSort(raw: string | null): SortKey {
  if (raw === "installed" || raw === "uninstalled" || raw === "redemptions" || raw === "flags") return raw;
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

  if (search) where.shopDomain = { contains: search, mode: "insensitive" };
  if (filter === "active") where.uninstalledAt = null;
  else if (filter === "uninstalling") where.uninstalledAt = { gte: fortyEightHoursAgo };
  else if (filter === "redacted") where.uninstalledAt = { lt: fortyEightHoursAgo };

  const [total, shops] = await Promise.all([
    prisma.shop.count({ where }),
    prisma.shop.findMany({
      where,
      orderBy: sort === "uninstalled" ? { uninstalledAt: "desc" } : { installedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        shopDomain: true,
        installedAt: true,
        uninstalledAt: true,
        protectedDataLevel: true,
        _count: { select: { protectedOffers: true, redemptionRecords: true, flaggedOrders: true } },
      },
    }),
  ]);

  let rows = shops;
  if (sort === "redemptions") {
    rows = [...shops].sort((a, b) => b._count.redemptionRecords - a._count.redemptionRecords);
  } else if (sort === "flags") {
    rows = [...shops].sort((a, b) => b._count.flaggedOrders - a._count.flaggedOrders);
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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

export default function AdminShopsIndex() {
  const { rows, total, page, pageCount, search, filter, sort } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const buildHref = (overrides: Record<string, string>): string => {
    const params = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === "") params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/admin/shops?${qs}` : "/admin/shops";
  };

  const start = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = (page - 1) * PAGE_SIZE + rows.length;
  const rangeLabel =
    total > 0
      ? `Showing ${start}–${end} of ${total.toLocaleString()}`
      : "0 shops";

  return (
    <s-page heading="Shops">
      <s-section
        padding="none"
        heading={rangeLabel}
        accessibilityLabel="Shops table"
      >
        <form method="get">
          <s-table
            paginate={pageCount > 1}
            hasPreviousPage={page > 1}
            hasNextPage={page < pageCount}
            onPreviousPage={() => navigate(buildHref({ page: String(page - 1) }))}
            onNextPage={() => navigate(buildHref({ page: String(page + 1) }))}
          >
            <s-grid
              slot="filters"
              gap="small-200"
              gridTemplateColumns="1fr auto auto auto"
            >
              <s-text-field
                name="q"
                label="Search shop domain"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search shop domain…"
                value={search}
                icon="search"
              />
              <s-select
                name="filter"
                label="Filter"
                labelAccessibilityVisibility="exclusive"
                value={filter}
              >
                {FILTERS.map((f) => (
                  <s-option key={f.key} value={f.key}>
                    {f.label}
                  </s-option>
                ))}
              </s-select>
              <s-select
                name="sort"
                label="Sort"
                labelAccessibilityVisibility="exclusive"
                value={sort}
              >
                {SORTS.map((s) => (
                  <s-option key={s.key} value={s.key}>
                    Sort: {s.label}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit" variant="primary">
                Apply
              </s-button>
            </s-grid>

            <s-table-header-row>
              <s-table-header listSlot="primary">Shop</s-table-header>
              <s-table-header>Installed</s-table-header>
              <s-table-header>Uninstalled</s-table-header>
              <s-table-header format="numeric">Offers</s-table-header>
              <s-table-header format="numeric">Redemptions</s-table-header>
              <s-table-header format="numeric">Flags</s-table-header>
            </s-table-header-row>

            <s-table-body>
              {rows.length === 0 ? (
                <s-table-row>
                  <s-table-cell>
                    <s-paragraph color="subdued">
                      No shops match these filters.
                    </s-paragraph>
                  </s-table-cell>
                </s-table-row>
              ) : (
                rows.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-link href={`/admin/shops/${row.id}`}>
                          {row.shopDomain}
                        </s-link>
                        <s-badge tone={row.uninstalledAt ? "neutral" : "success"}>
                          {row.uninstalledAt ? "Uninstalled" : "Active"}
                        </s-badge>
                        {row.protectedDataLevel > 0 && (
                          <s-badge>L{row.protectedDataLevel}</s-badge>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{formatDate(row.installedAt)}</s-table-cell>
                    <s-table-cell>{formatDate(row.uninstalledAt)}</s-table-cell>
                    <s-table-cell>{row.offerCount}</s-table-cell>
                    <s-table-cell>{row.redemptionCount.toLocaleString()}</s-table-cell>
                    <s-table-cell>{row.flagCount.toLocaleString()}</s-table-cell>
                  </s-table-row>
                ))
              )}
            </s-table-body>
          </s-table>
        </form>
      </s-section>
    </s-page>
  );
}
