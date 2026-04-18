/**
 * See: docs/landing-page-spec.md §4
 */

import { Outlet } from "react-router";

import { Footer } from "../components/public/footer";

import "../styles/public.css";

export default function PublicLayout() {
  return (
    <div className="pg-public">
      <header className="pg-public__header">
        <a href="/" className="pg-public__brand">
          Promo Guard
        </a>
        <nav aria-label="Primary">
          <a href="/pricing">Pricing</a>
          <a href="/security">Security</a>
          <a href="/install" className="pg-public__cta">
            Install
          </a>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
