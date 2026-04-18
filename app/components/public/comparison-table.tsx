/**
 * See: docs/landing-page-spec.md §4
 */

const ROWS: Array<{ problem: string; without: string; withPg: string }> = [
  {
    problem: "Same person, new email",
    without: "Goes through",
    withPg: "Blocked / flagged",
  },
  {
    problem: "Same address",
    without: "Goes through",
    withPg: "Blocked / flagged",
  },
  {
    problem: "Same phone",
    without: "Goes through",
    withPg: "Blocked / flagged",
  },
  {
    problem: "Gmail dot / + tricks",
    without: "Goes through",
    withPg: "Normalized & caught",
  },
  {
    problem: "False positives",
    without: "—",
    withPg: "< 1% on beta stores",
  },
];

export function ComparisonTable() {
  return (
    <section className="pg-compare" aria-labelledby="pg-compare-heading">
      <div className="pg-compare__inner">
        <h2 id="pg-compare-heading" className="pg-compare__heading">
          Without vs. with Promo Guard
        </h2>
        <table className="pg-compare__table">
          <thead>
            <tr>
              <th scope="col">Problem</th>
              <th scope="col">Without Promo Guard</th>
              <th scope="col">With Promo Guard</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.problem}>
                <th scope="row">{row.problem}</th>
                <td className="pg-compare__bad">{row.without}</td>
                <td className="pg-compare__good">{row.withPg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
