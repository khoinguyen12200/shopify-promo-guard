/**
 * See: docs/platform-admin-spec.md §3 (URL structure / layout)
 * Related: docs/platform-admin-spec.md §2 (access control)
 */

import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, Form, NavLink } from "react-router";
import { requireAdminSession } from "~/lib/admin-auth.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  return { email: adminUser.email };
};

const NAV: Array<{ to: string; label: string; end?: boolean }> = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/shops", label: "Shops" },
  { to: "/admin/jobs", label: "Jobs" },
  { to: "/admin/dead-letters", label: "Dead-letters" },
  { to: "/admin/compliance", label: "Compliance" },
  { to: "/admin/feature-flags", label: "Feature flags" },
  { to: "/admin/audit", label: "Audit" },
  { to: "/admin/metrics", label: "Metrics" },
];

export default function AdminLayout() {
  const { email } = useLoaderData<typeof loader>();

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", background: "#1a1a2e", color: "#eee", fontSize: 13 }}>
        <span style={{ fontWeight: 600, marginRight: 12, whiteSpace: "nowrap" }}>
          Promo Guard <span style={{ opacity: 0.45 }}>Platform</span>
        </span>
        <nav style={{ display: "flex", gap: 2, flex: 1, flexWrap: "wrap" }} aria-label="Platform admin">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                padding: "5px 10px",
                borderRadius: 4,
                textDecoration: "none",
                color: isActive ? "#fff" : "#9ca3af",
                background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
          <span style={{ opacity: 0.5, fontSize: 12, whiteSpace: "nowrap" }} title={email}>{email}</span>
          <Form method="post" action="/admin/logout">
            <button
              type="submit"
              style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#ccc", padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
            >
              Sign out
            </button>
          </Form>
        </div>
      </header>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
    </div>
  );
}
