/**
 * See: docs/landing-page-spec.md §4
 */

const STEPS = [
  "Install Promo Guard, pick your welcome offer.",
  "We watch every redemption — phone, address, device, similar email.",
  "Repeat abuse is blocked at checkout. Borderline cases are flagged for review.",
];

export function ThreeStep() {
  return (
    <section
      className="pg-three-step"
      id="how"
      aria-labelledby="pg-three-step-heading"
    >
      <div className="pg-three-step__inner">
        <h2 id="pg-three-step-heading" className="pg-three-step__heading">
          How it works
        </h2>
        <ol className="pg-three-step__steps" aria-label="Three steps">
          {STEPS.map((text, i) => (
            <li key={i} className="pg-three-step__step">
              <span className="pg-three-step__num" aria-hidden="true">
                {i + 1}
              </span>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
