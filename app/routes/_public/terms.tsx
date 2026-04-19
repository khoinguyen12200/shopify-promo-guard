/**
 * See: docs/landing-page-spec.md §2 (terms of service page), §6 (related privacy)
 */

import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Terms of service — Promo Guard" },
  {
    name: "description",
    content:
      "The agreement between merchants who install Promo Guard and the app publisher.",
  },
];

const LAST_UPDATED = "April 18, 2026";

export default function PublicTerms() {
  return (
    <article className="pg-doc" aria-labelledby="pg-terms-heading">
      <div className="pg-doc__inner">
        <h1 id="pg-terms-heading" className="pg-doc__heading">
          Terms of service
        </h1>
        <p className="pg-doc__updated">Last updated: {LAST_UPDATED}</p>

        <section aria-labelledby="pg-terms-agreement">
          <h2 id="pg-terms-agreement">1. Agreement</h2>
          <p>
            By installing Promo Guard on your Shopify store, you agree to
            these terms. If you do not agree, do not install the app.
          </p>
        </section>

        <section aria-labelledby="pg-terms-service">
          <h2 id="pg-terms-service">2. The service</h2>
          <p>
            Promo Guard is software that helps detect and prevent repeat
            redemption of welcome discount codes on Shopify stores. It runs as
            a combination of Shopify Functions (validation and discount) and a
            merchant-facing admin UI embedded in the Shopify admin.
          </p>
          <p>
            We provide the service on a best-effort basis. We do not guarantee
            that every abusive redemption is blocked, nor that no legitimate
            customer will ever be affected by a false positive.
          </p>
        </section>

        <section aria-labelledby="pg-terms-billing">
          <h2 id="pg-terms-billing">3. Billing</h2>
          <p>
            Paid tiers are billed monthly through Shopify Billing. If your
            usage exceeds your tier&apos;s monthly redemption cap, additional
            redemptions are not scored until the next billing cycle or until
            you upgrade. We do not bill overage.
          </p>
          <p>
            Refunds are handled through Shopify&apos;s standard app-refund
            channels.
          </p>
        </section>

        <section aria-labelledby="pg-terms-data">
          <h2 id="pg-terms-data">4. Data</h2>
          <p>
            You retain ownership of all merchant and customer data. We process
            it as your data processor, under the terms of our{" "}
            <a href="/privacy">privacy policy</a> and{" "}
            <a href="/security">security commitments</a>.
          </p>
          <p>
            Uninstalling the app starts a 48-hour grace window, after which
            all shop-owned data is purged.
          </p>
        </section>

        <section aria-labelledby="pg-terms-acceptable">
          <h2 id="pg-terms-acceptable">5. Acceptable use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>
              Use Promo Guard to discriminate against customers based on
              protected characteristics.
            </li>
            <li>
              Reverse-engineer, decompile, or attempt to extract source code
              from the Shopify Functions or admin extension.
            </li>
            <li>
              Use the service to violate any law, Shopify&apos;s partner program
              agreement, or a third party&apos;s rights.
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-terms-warranty">
          <h2 id="pg-terms-warranty">6. No warranty</h2>
          <p>
            Promo Guard is provided &quot;as is&quot; without warranties of any kind.
            We are not liable for lost revenue, lost margin, or damages
            arising from the app&apos;s operation or non-operation, beyond the
            amount you paid us in the twelve months preceding the claim.
          </p>
        </section>

        <section aria-labelledby="pg-terms-termination">
          <h2 id="pg-terms-termination">7. Termination</h2>
          <p>
            You may uninstall the app at any time from your Shopify admin. We
            may terminate service to a merchant that materially breaches these
            terms after written notice and an opportunity to cure.
          </p>
        </section>

        <section aria-labelledby="pg-terms-changes">
          <h2 id="pg-terms-changes">8. Changes</h2>
          <p>
            We may update these terms. Material changes will be announced via
            the app&apos;s in-product notification and the merchant&apos;s primary
            contact email on file with Shopify, at least 30 days before they
            take effect.
          </p>
        </section>

        <section aria-labelledby="pg-terms-contact">
          <h2 id="pg-terms-contact">9. Contact</h2>
          <p>
            <a href="mailto:support@promoguard.app">support@promoguard.app</a>
          </p>
        </section>
      </div>
    </article>
  );
}
