/**
 * See: docs/landing-page-spec.md §5 (pricing tiers + FAQ)
 * Related: docs/landing-page-spec.md §12 (copy voice)
 */

import type { MetaFunction } from "react-router";

const TIERS: Array<{
  name: string;
  price: string;
  cap: string;
  cta: string;
}> = [
  {
    name: "Free",
    price: "$0",
    cap: "100 redemptions per month",
    cta: "Install free",
  },
  {
    name: "Starter",
    price: "$19",
    cap: "1,000 redemptions per month",
    cta: "Install",
  },
  {
    name: "Growth",
    price: "$49",
    cap: "10,000 redemptions per month",
    cta: "Install",
  },
];

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: 'What counts as a "redemption"?',
    a: "Every paid order that used one of your protected codes.",
  },
  {
    q: "Do you work with Shopify Plus?",
    a: "Yes, identically. Plus-specific features (checkout customization) aren't our focus.",
  },
  {
    q: "Will this block legitimate customers?",
    a: "Rarely. We score on multiple signals, not just one, to minimize false positives. Legitimate buyers with no prior redemption are never affected.",
  },
  {
    q: "Do you see my customers' PII?",
    a: "We hash phone/email/address for matching and store raw encrypted copies only for compliance purposes. Per-shop salt prevents cross-shop correlation.",
  },
  {
    q: "What if I want to undo protection?",
    a: "Delete the protected offer; we restore any discounts we replaced. No lock-in.",
  },
  {
    q: "What if the same family orders from the same address?",
    a: "First order goes through normally. A second order using the same code would be blocked or silently skipped. They can still check out at full price.",
  },
  {
    q: "How do I test it without going live?",
    a: "Install on a dev store, create a test protected offer, redeem once, try to redeem again.",
  },
  {
    q: "What data do you store?",
    a: "Hashed identity signals (for matching), encrypted raw values (for compliance deletion), order references. See our privacy page for the full list.",
  },
];

export const meta: MetaFunction = () => [
  { title: "Pricing — Promo Guard" },
  {
    name: "description",
    content:
      "Simple volume-based pricing. Free for your first 100 redemptions per month. All features included at every tier.",
  },
];

export default function PublicPricing() {
  return (
    <>
      <section className="pg-pricing" aria-labelledby="pg-pricing-heading">
        <div className="pg-pricing__inner">
          <h1 id="pg-pricing-heading" className="pg-pricing__heading">
            Simple pricing. All features at every tier.
          </h1>
          <p className="pg-pricing__sub">
            Billed monthly via Shopify. The only difference between tiers is
            the monthly redemption cap. Above-cap redemptions aren&apos;t blocked —
            they&apos;re just not scored until the next billing cycle or an upgrade.
          </p>
          <div className="pg-pricing__tiers">
            {TIERS.map((tier) => (
              <article key={tier.name} className="pg-pricing__tier">
                <h2 className="pg-pricing__tier-name">{tier.name}</h2>
                <p className="pg-pricing__tier-price">
                  {tier.price}
                  <span className="pg-pricing__tier-unit"> /month</span>
                </p>
                <p className="pg-pricing__tier-cap">{tier.cap}</p>
                <p className="pg-pricing__tier-features">All features</p>
                <a
                  href="/install"
                  className="pg-btn pg-btn--primary pg-pricing__tier-cta"
                >
                  {tier.cta}
                </a>
              </article>
            ))}
          </div>
          <p className="pg-pricing__enterprise">
            Need more than 10,000 redemptions per month?{" "}
            <a href="mailto:hello@promoguard.app">Contact us</a> for an
            Enterprise tier.
          </p>
        </div>
      </section>

      <section className="pg-faq" aria-labelledby="pg-pricing-faq-heading">
        <div className="pg-faq__inner">
          <h2 id="pg-pricing-faq-heading" className="pg-faq__heading">
            Frequently asked
          </h2>
          {FAQS.map(({ q, a }) => (
            <details key={q} className="pg-faq__item">
              <summary>{q}</summary>
              <p className="pg-faq__answer">{a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
