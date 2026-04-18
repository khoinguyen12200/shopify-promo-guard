/**
 * See: docs/landing-page-spec.md §7 (security page)
 * Related: docs/system-design.md § Privacy
 */

import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Security — Promo Guard" },
  {
    name: "description",
    content:
      "How Promo Guard secures merchant and customer data: encryption, key management, access control, audit logging, and incident response.",
  },
];

export default function PublicSecurity() {
  return (
    <article className="pg-doc" aria-labelledby="pg-security-heading">
      <div className="pg-doc__inner">
        <h1 id="pg-security-heading" className="pg-doc__heading">
          Security
        </h1>
        <p className="pg-doc__lede">
          How we handle merchant and customer data. Written for the Shopify
          Level 2 protected customer data review, and for any merchant or
          security researcher who asks.
        </p>

        <section aria-labelledby="pg-security-encryption">
          <h2 id="pg-security-encryption">Encryption</h2>
          <ul>
            <li>TLS 1.3 in transit for every request.</li>
            <li>
              AES-256-GCM at rest for every column that stores personally
              identifying information (email, phone, address).
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-security-keys">
          <h2 id="pg-security-keys">Key management</h2>
          <ul>
            <li>
              Each shop gets its own Data Encryption Key (DEK), generated on
              install.
            </li>
            <li>
              Each DEK is wrapped by an app Key Encryption Key (KEK) stored in
              a managed KMS (GCP Secret Manager).
            </li>
            <li>
              The unwrapped DEK only exists in memory inside the single
              function that performs decryption; it drops scope immediately
              after use.
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-security-access">
          <h2 id="pg-security-access">Access control</h2>
          <ul>
            <li>Team SSO via Google Workspace with MFA required.</li>
            <li>
              Production database access is read-only by default; write access
              is granted ad hoc for a specific, logged task.
            </li>
            <li>
              Platform admin tooling is gated by an email allowlist plus
              magic-link auth.
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-security-audit">
          <h2 id="pg-security-audit">Audit logging</h2>
          <p>
            Every time a Promo Guard team member accesses merchant data through
            our platform admin tool, we record who accessed what, when, and
            why. Decrypted PII views are gated behind a reason-before-reveal
            prompt that also goes into the audit log.
          </p>
        </section>

        <section aria-labelledby="pg-security-infra">
          <h2 id="pg-security-infra">Infrastructure</h2>
          <ul>
            <li>Hosted on Google Cloud Platform, region us-central1.</li>
            <li>Backups encrypted at rest; retention matches data policy.</li>
            <li>
              Deletion follows the retention policy stated on our privacy
              page. Uninstall triggers a 48-hour grace window, then purge.
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-security-incident">
          <h2 id="pg-security-incident">Incident response</h2>
          <p>
            If we detect a breach that affects merchant data, we commit to a
            72-hour notification window to affected merchants and to
            Shopify&apos;s partner security contact.
          </p>
        </section>

        <section aria-labelledby="pg-security-compliance">
          <h2 id="pg-security-compliance">Compliance</h2>
          <ul>
            <li>GDPR subprocessor agreements with every data processor.</li>
            <li>
              Shopify compliance webhooks (<code>customers/data_request</code>,
              {" "}<code>customers/redact</code>, <code>shop/redact</code>)
              wired end-to-end with automated purge jobs.
            </li>
          </ul>
        </section>

        <section aria-labelledby="pg-security-reach">
          <h2 id="pg-security-reach">Reach out</h2>
          <p>
            Security researchers and concerned merchants:{" "}
            <a href="mailto:security@promoguard.app">security@promoguard.app</a>
            . We reply within one business day.
          </p>
        </section>
      </div>
    </article>
  );
}
