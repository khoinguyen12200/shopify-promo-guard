/**
 * See: docs/landing-page-spec.md §4
 */

export function ProblemBlock() {
  return (
    <section className="pg-problem" aria-labelledby="pg-problem-heading">
      <div className="pg-problem__inner">
        <h2 id="pg-problem-heading" className="pg-problem__heading">
          Welcome-offer abuse is invisible until it adds up.
        </h2>
        <ul className="pg-problem__list">
          <li>Same person, five emails. Your 20%-off went out five times.</li>
          <li>Shopify only checks the email field. We check everything.</li>
          <li>You lose margin and acquisition signal in one shot.</li>
        </ul>
      </div>
    </section>
  );
}
