/**
 * See: docs/landing-page-spec.md §6 (privacy policy)
 * Related: docs/system-design.md § Privacy
 */

import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Privacy policy — Promo Guard" },
  {
    name: "description",
    content:
      "How Promo Guard collects, uses, and protects merchant and customer data.",
  },
];

const LAST_UPDATED = "April 18, 2026";

export default function PublicPrivacy() {
  return (
    <article className="pg-doc" aria-labelledby="pg-privacy-heading">
      <div className="pg-doc__inner">
        <h1 id="pg-privacy-heading" className="pg-doc__heading">
          Privacy policy
        </h1>
        <p className="pg-doc__updated">Last updated: {LAST_UPDATED}</p>

        <section aria-labelledby="pg-privacy-who">
          <h2 id="pg-privacy-who">1. Who we are</h2>
          <p>
            Promo Guard is a Shopify app that helps merchants prevent repeat
            abuse of welcome discount codes. The app is published by Promo
            Guard. Support:{" "}
            <a href="mailto:support@promoguard.app">support@promoguard.app</a>.
          </p>
        </section>

        <section aria-labelledby="pg-privacy-what">
          <h2 id="pg-privacy-what">2. What data we collect</h2>
          <p>From Shopify, on behalf of each installing merchant:</p>
          <ul>
            <li>Order email, phone, shipping address, billing address</li>
            <li>IP address at checkout</li>
            <li>Customer ID (when the shopper is logged in)</li>
            <li>Discount codes used on the order</li>
          </ul>
          <p>From merchants:</p>
          <ul>
            <li>Shop domain</li>
            <li>OAuth scopes granted to Promo Guard</li>
          </ul>
        </section>

        <section aria-labelledby="pg-privacy-why">
          <h2 id="pg-privacy-why">3. Why we collect it</h2>
          <p>Solely to score welcome-offer abuse. Specifically:</p>
          <ul>
            <li>
              Hash email, phone, and address so we can match future redemptions
              without storing raw PII in our scoring index.
            </li>
            <li>
              Compute near-duplicate signals (e.g. similar email variants, same
              household address) to catch repeat abusers using new emails.
            </li>
            <li>
              Block or flag subsequent redemptions according to the merchant&apos;s
              configured policy.
            </li>
          </ul>
          <p>
            We do not sell data, we do not use it for advertising, and we do
            not share it with third parties beyond the subprocessors listed
            below.
          </p>
        </section>

        <section aria-labelledby="pg-privacy-retain">
          <h2 id="pg-privacy-retain">4. How long we keep it</h2>
          <p>By default:</p>
          <ul>
            <li>Two years from the redemption date, or</li>
            <li>Until the merchant deletes the protected offer, or</li>
            <li>
              Until the merchant uninstalls Promo Guard (48-hour grace window,
              then purged).
            </li>
          </ul>
          <p>Merchants can configure a shorter retention period in-app.</p>
        </section>

        <section aria-labelledby="pg-privacy-sub">
          <h2 id="pg-privacy-sub">5. Subprocessors</h2>
          <ul>
            <li>
              <strong>Neon</strong> — managed Postgres hosting.{" "}
              <a
                href="https://neon.tech/privacy-policy"
                target="_blank"
                rel="noreferrer noopener"
              >
                Privacy policy
              </a>
              .
            </li>
            <li>
              <strong>Google Cloud Platform</strong> — application hosting
              (Cloud Run, Secret Manager).{" "}
              <a
                href="https://cloud.google.com/terms/cloud-privacy-notice"
                target="_blank"
                rel="noreferrer noopener"
              >
                Privacy notice
              </a>
              .
            </li>
            <li>
              <strong>Shopify</strong> — merchant platform and data source.{" "}
              <a
                href="https://www.shopify.com/legal/privacy"
                target="_blank"
                rel="noreferrer noopener"
              >
                Privacy policy
              </a>
              .
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-privacy-rights">
          <h2 id="pg-privacy-rights">6. Rights of end customers</h2>
          <p>
            If you are an end customer of a store that uses Promo Guard and you
            want to exercise data access or erasure rights, contact the
            merchant first. The merchant can submit a data request or erasure
            request, which reaches us via Shopify&apos;s compliance webhooks
            (<code>customers/data_request</code>, <code>customers/redact</code>
            ). We honor those within Shopify&apos;s SLA.
          </p>
        </section>

        <section aria-labelledby="pg-privacy-security">
          <h2 id="pg-privacy-security">7. Security controls</h2>
          <p>
            Encryption at rest, per-shop salts, access controls, and audit
            logging. See <a href="/security">our security page</a> for
            specifics.
          </p>
        </section>

        <section aria-labelledby="pg-privacy-contact">
          <h2 id="pg-privacy-contact">8. Contact for privacy concerns</h2>
          <p>
            <a href="mailto:privacy@promoguard.app">privacy@promoguard.app</a>
          </p>
        </section>
      </div>
    </article>
  );
}
