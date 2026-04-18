/**
 * See: docs/platform-admin-spec.md §3 (URL structure / layout)
 * Related: docs/platform-admin-spec.md §2 (access control)
 */

import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, Form, NavLink } from "react-router";
import { requireAdminSession } from "../lib/admin-auth.server.js";
import adminStyles from "../styles/admin.css?url";

export const links = () => [{ rel: "stylesheet", href: adminStyles }];

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
];

export default function AdminLayout() {
  const { email } = useLoaderData<typeof loader>();

  return (
    <div className="pg-admin">
      <header className="pg-admin__header">
        <div className="pg-admin__brand">
          <span className="pg-admin__dot" />
          Promo Guard <span className="pg-admin__brand-sub">Platform</span>
        </div>
        <nav className="pg-admin__nav" aria-label="Platform admin">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                "pg-admin__nav-link" +
                (isActive ? " pg-admin__nav-link--active" : "")
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="pg-admin__user">
          <span className="pg-admin__email" title={email}>
            {email}
          </span>
          <Form method="post" action="/admin/logout">
            <button type="submit" className="pg-admin__logout">
              Sign out
            </button>
          </Form>
        </div>
      </header>
      <main className="pg-admin__main">
        <Outlet />
      </main>
    </div>
  );
}
