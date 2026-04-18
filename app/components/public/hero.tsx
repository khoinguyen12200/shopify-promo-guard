/**
 * See: docs/landing-page-spec.md §4
 */

export function Hero() {
  return (
    <section className="pg-hero" aria-labelledby="pg-hero-headline">
      <div className="pg-hero__inner">
        <h1 id="pg-hero-headline" className="pg-hero__headline">
          Stop welcome-offer abuse before it costs you.
        </h1>
        <p className="pg-hero__sub">
          Promo Guard catches repeat redemptions even when the abuser uses a
          new email. Ship in 5 minutes. Works on every Shopify plan.
        </p>
        <div className="pg-hero__ctas">
          <a href="/install" className="pg-btn pg-btn--primary">
            Install on Shopify
          </a>
          <a href="#how" className="pg-btn pg-btn--secondary">
            See how it works
          </a>
        </div>
        <p className="pg-hero__social">
          <span className="pg-hero__stars" aria-hidden="true">
            ★★★★★
          </span>
          <span className="sr-only">Five stars. </span>
          Saved us $4,200 the first month — a merchant, after beta
        </p>
      </div>
    </section>
  );
}
