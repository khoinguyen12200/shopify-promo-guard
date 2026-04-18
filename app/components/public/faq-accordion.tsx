/**
 * See: docs/landing-page-spec.md §4
 */

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "Does Promo Guard require Shopify Plus?",
    a: "No. Basic / Shopify / Advanced all work. Starter is excluded.",
  },
  {
    q: "What data do you store?",
    a: "Hashes + encrypted PII. See our security page.",
  },
  {
    q: "Does it slow down checkout?",
    a: "No. Our Function runs in < 5ms on the median checkout.",
  },
  {
    q: "What happens if I uninstall?",
    a: "48-hour grace period to reinstall, then all data is deleted per Shopify policy.",
  },
];

export function FaqAccordion() {
  return (
    <section className="pg-faq" aria-labelledby="pg-faq-heading">
      <div className="pg-faq__inner">
        <h2 id="pg-faq-heading" className="pg-faq__heading">
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
  );
}
