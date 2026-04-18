/**
 * See: docs/platform-admin-spec.md §3 (URL structure / layout)
 * Related: docs/platform-admin-spec.md §2 (access control)
 */

import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, Link, NavLink } from "react-router";
import { requireAdminSession } from "../lib/admin-auth.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  return { email: adminUser.email };
};

export default function AdminLayout() {
  const { email } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "monospace", fontSize: "14px" }}>
      <nav
        style={{
          background: "#1a1a2e",
          color: "#eee",
          padding: "8px 16px",
          display: "flex",
          gap: "16px",
          alignItems: "center",
        }}
      >
        <strong style={{ color: "#f0c040", marginRight: "16px" }}>
          Promo Guard — Platform
        </strong>
        <NavLink to="/admin" end style={navStyle}>
          Dashboard
        </NavLink>
        <NavLink to="/admin/shops" style={navStyle}>
          Shops
        </NavLink>
        <NavLink to="/admin/jobs" style={navStyle}>
          Jobs
        </NavLink>
        <NavLink to="/admin/dead-letters" style={navStyle}>
          Dead-letters
        </NavLink>
        <NavLink to="/admin/compliance" style={navStyle}>
          Compliance
        </NavLink>
        <NavLink to="/admin/feature-flags" style={navStyle}>
          Feature flags
        </NavLink>
        <NavLink to="/admin/audit" style={navStyle}>
          Audit
        </NavLink>
        <span style={{ marginLeft: "auto", color: "#aaa", fontSize: "12px" }}>
          {email}
        </span>
        <Link to="/admin/logout" style={{ color: "#f88", fontSize: "12px" }}>
          Logout
        </Link>
      </nav>
      <div style={{ padding: "16px" }}>
        <Outlet />
      </div>
    </div>
  );
}

function navStyle({ isActive }: { isActive: boolean }): React.CSSProperties {
  return {
    color: isActive ? "#f0c040" : "#ccc",
    textDecoration: "none",
  };
}
