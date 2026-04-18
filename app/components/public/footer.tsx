/**
 * See: docs/landing-page-spec.md §4
 */

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="pg-footer" aria-label="Site footer">
      <div className="pg-footer__inner">
        <nav className="pg-footer__links" aria-label="Footer links">
          <a href="/pricing">Pricing</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/security">Security</a>
          <a href="/install">Install on Shopify</a>
        </nav>
        <p style={{ margin: 0 }}>© {year} Promo Guard</p>
      </div>
    </footer>
  );
}
