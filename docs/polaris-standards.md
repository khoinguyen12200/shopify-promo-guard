# Polaris web components — project standards

Source of truth: https://shopify.dev/docs/api/app-home (Polaris App Home web components).
This file is the project's compiled reference — what elements to pick, how to
nest them, and what spacing tokens to use. Written strictly from Shopify's
published component docs and pattern compositions. **Cite this file in PRs
that touch UI.**

All merchant routes (`/app/*`) and platform admin routes (`/admin/*`) MUST
follow these rules. `@shopify/polaris-types` provides JSX typings — use
camelCase props (`inlineSize`, not `inline-size`).

## 1. Spacing scale

The ONLY valid spacing tokens (use anywhere `gap` / `padding` / `rowGap` /
`columnGap` / `paddingBlock` / `paddingInline` appear):

```
none
small-500  small-400  small-300  small-200  small-100  small
base
large  large-100  large-200  large-300  large-400  large-500
```

How to pick:

| Context | Token |
|---|---|
| Tight inline grouping (icon + value, badge + label) | `small-200` |
| Form-field spacing inside a card (label → input → next field) | `small-300` |
| Between cards in a responsive grid | `base` |
| Between sections within a page | handled automatically by `<s-section>` |
| Header with trailing icon buttons | `small-300` |
| Metric card inner stack | `small-200`–`small-300` |

Wrong spacing symptoms: everything stacking in one column, nothing breathing,
or everything too far apart. Default to `base` for general rhythm;
drop to `small-200` / `small-300` for items that visually belong together.

## 2. Page (`<s-page>`)

- `inlineSize="small"` → focused single-column forms (login, simple settings).
- `inlineSize="base"` (default) → most pages (details/edit).
- `inlineSize="large"` → data-rich dashboards, wide tables.
- The `aside` slot ONLY renders when `inlineSize="base"`.
- Slots: `primary-action` (exactly 1 button), `secondary-actions` (≤ 3),
  `breadcrumb-actions` (links only), `aside`.
- **Never put action buttons at the bottom of a page.** Primary and
  secondary actions live in the header via slots.
- Breadcrumbs belong in the header via `<s-link slot="breadcrumb-actions">`.

Form pages: the `<form>` element WRAPS `<s-page>`, not the other way around.
That way the page-slot `<s-button slot="primary-action" type="submit">` fires
the form.

```tsx
<form method="post">
  <s-page heading="Edit offer">
    <s-link slot="breadcrumb-actions" href="/app/offers">Offers</s-link>
    <s-button slot="secondary-actions" href="/app/offers">Cancel</s-button>
    <s-button slot="primary-action" variant="primary" type="submit">Save</s-button>
    <s-section heading="Offer information">...</s-section>
  </s-page>
</form>
```

### Aside column (`slot="aside"`)

Use the aside for secondary metadata that the user reads but rarely edits.
On desktop it renders as a narrower right column alongside the main content.
On mobile it stacks below.

**Put in aside:**
- Status badge + mode label + pause/resume
- Code list (read-only)
- Enforcement mode choice on forms (secondary config, not the primary task)
- Help text / infrequent settings (e.g. Uninstall)

**Keep in main:**
- Primary data entry (name, codes picker)
- Metrics, charts, data tables
- Destructive or high-impact settings

```tsx
<s-page heading="Offer name">
  {/* aside renders to the right on desktop */}
  <s-section slot="aside" heading="Status">
    <s-badge tone="success">Active</s-badge>
  </s-section>

  <s-section slot="aside" heading="Enforcement mode">
    <s-choice-list name="mode" label="Mode"
                   labelAccessibilityVisibility="exclusive"
                   values={[mode]}>
      <s-choice value="silent_strip">Silently skip</s-choice>
      <s-choice value="block">Block checkout</s-choice>
    </s-choice-list>
  </s-section>

  {/* main column */}
  <s-section heading="Last 30 days">
    {/* metrics grid */}
  </s-section>
</s-page>
```

Rule: don't put anything in the aside that a user *must* complete before
submitting the form. The aside is visually de-emphasised — important required
fields belong in the main column.

## 3. Section (`<s-section>`)

- Every section needs a `heading` OR an `accessibilityLabel`. Descriptive,
  not generic: "Offer information", "Redemption limits" — never "Name".
- `padding="base"` (default) OR `padding="none"` (for full-bleed content
  like tables; restore padding with `<s-box padding="base">` inside if
  needed).
- **Nesting is how you get visual hierarchy**, not manual styling:
  - Level 1 section (direct child of page) → elevated / shadow on desktop.
  - Level 2 (nested) → flatter visual treatment, heading becomes h3.
  - Level 3 → even flatter, heading becomes h4.
- Use nested sections for grouped subforms (e.g. "Offer info" → "Codes" →
  "Limits"), never for every label.

## 4. Headings and text

| Component | When |
|---|---|
| `<s-heading>` | ONLY inside a `<s-section>`. Levels auto-assigned from nesting depth. Don't hand-roll an h1 — `<s-page heading>` owns that. |
| `<s-paragraph>` | Block-level prose — descriptions, body copy, help text. Supports `color="subdued"` and `tone` (info/success/warning/critical/caution). |
| `<s-text>` | Inline text styling inside a paragraph or stack. Supports `type="strong" | "generic" | "address" | "redundant"`. |

Common mistakes:
- Using `<s-text>` where `<s-paragraph>` belongs (block-level descriptions).
- Using `<s-heading>` as a form field label — the `label` prop on the
  input already provides that. Don't double up.

## 5. Form fields

All field components share the same label/error/details API:

- `label` — always required; do not hide unless redundant.
- `labelAccessibilityVisibility="visible"` (default) or `"exclusive"` for
  screen-reader-only when the surrounding context already labels it
  visually (e.g. a single search field in a filter bar).
- `details="…"` — hint/helper text rendered beneath the field. Use this
  instead of a separate `<s-paragraph>`.
- `error="Specific message"` — be specific. "Weight must be > 0 and < 500
  lbs" beats "Invalid value".
- `required` — boolean, adds the visual indicator + semantic meaning.
- `name` — required for form submission.
- `autocomplete` — lowercase HTML-standard (e.g. `"email"`, not
  `autoComplete`).

Field components by data type:
`<s-text-field>`, `<s-email-field>`, `<s-url-field>`, `<s-password-field>`,
`<s-search-field>`, `<s-number-field>`, `<s-money-field>`,
`<s-color-field>`, `<s-date-field>`, `<s-text-area>`, `<s-select>`,
`<s-checkbox>`, `<s-choice-list>` (+ `<s-choice>`), `<s-switch>`,
`<s-drop-zone>`.

**Never use raw `<input>` / `<select>` / `<textarea>`.** Use the `<s-*>`
equivalent.

## 6. Choice list vs checkbox vs switch

- **`<s-choice-list>`** with `<s-choice>` children = group of related
  options. Default is single-select (radio behavior). `multiple={true}`
  switches it to checkbox behavior.
- **`<s-checkbox>`** = standalone boolean (accept terms, enable feature).
- **`<s-switch>`** = on/off toggle for immediate state (dark mode, push
  notifications). Not for deferred form submission — for that, use
  `<s-checkbox>`.

## 7. Button

- `variant="primary"` — high emphasis, used sparingly (usually in
  `primary-action` slot).
- `variant="secondary"` — medium, default for most actions.
- `variant="tertiary"` — low emphasis, icon-only, menu triggers.
- `variant="auto"` — let the container decide.
- `tone="critical"` — destructive actions (Delete).
- `tone="neutral"` — quieter secondary.
- `tone="auto"` — default.
- Icon-only buttons MUST have `accessibilityLabel`.

## 8. Banner

- `heading="…"` for the title, children for the body.
- Tones: `info | success | warning | critical`.
- Page-wide messages → banner OUTSIDE any section.
- Contextual messages → banner INSIDE the relevant section.
- Dismissible by default is `false`. Make user-dismissible banners
  persistent across reloads (local storage / server state) — the component
  does not persist dismissed state.

## 9. Stack vs Grid

- **`<s-stack>`** — linear layouts along one axis.
  - `direction="block"` (default, vertical) or `"inline"` (horizontal).
  - `gap`, `rowGap`, `columnGap` use the spacing scale.
  - `alignItems`, `justifyContent` for cross-axis / main-axis distribution.
  - Inline stacks wrap automatically.
- **`<s-grid>`** — multi-column or explicit grid positioning.
  - `gridTemplateColumns="1fr auto"` — classic label+action row.
  - `gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"` — responsive
    card grid.
  - `gridTemplateColumns="repeat(12, 1fr)"` + `<s-grid-item gridColumn="span 6">`
    — 12-column layout.
  - Container-query responsive: `gridTemplateColumns="@container (inline-size > 400px) 1fr 1fr 1fr, 1fr"`.

Rule of thumb: if there are two items side-by-side with distinct purposes
(label + action, input + button), `<s-grid gridTemplateColumns="1fr auto">`
beats an inline stack.

## 10. Box (`<s-box>`)

Generic styled container. Use when no semantic component fits:

```tsx
<s-box padding="base" background="base" borderRadius="base"
       borderWidth="base" borderColor="base">
  {/* card-like content */}
</s-box>
```

Prefer `<s-section>` for heading-containing card groups, `<s-clickable>`
for entire cards that navigate, and `<s-box>` only for non-interactive
visual containers (stat cards, subgroups).

## 11. Pattern: Metrics card (dashboard stat)

From Shopify's `metrics-card` composition. Standard shape per stat:

```tsx
<s-box padding="base" background="base" borderRadius="base"
       borderWidth="base" borderColor="base">
  <s-grid gap="small-300">
    <s-heading>{label}</s-heading>
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-text>{value.toLocaleString()}</s-text>
      {trend && <s-badge tone={trendTone} icon="arrow-up">+{trend}%</s-badge>}
    </s-stack>
  </s-grid>
</s-box>
```

Note: the LABEL is `<s-heading>` (semantic heading), the VALUE is
`<s-text>`. This follows the composition — do not swap them.

If the card is a drill-down, replace the outer `<s-box>` with
`<s-clickable href="…" paddingBlock="small-400" paddingInline="small-100" borderRadius="base">`.

Grid wrapper for a row of cards:

```tsx
<s-grid gap="base"
        gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))">
  {cards}
</s-grid>
```

## 12. Pattern: Setup guide / onboarding

From Shopify's `setup-guide` composition. Use for first-run onboarding.
**Never** hand-roll check marks with `"✓"` / `"□"` characters — use
`<s-checkbox>`.

Skeleton:

```tsx
<s-section>
  <s-grid gap="small">
    {/* Header */}
    <s-grid gap="small-200">
      <s-grid gridTemplateColumns="1fr auto auto"
              gap="small-300" alignItems="center">
        <s-heading>Setup guide</s-heading>
        <s-button icon="x" variant="tertiary" tone="neutral"
                  accessibilityLabel="Dismiss guide" />
        <s-button icon="chevron-up" variant="tertiary" tone="neutral"
                  accessibilityLabel="Toggle setup guide" />
      </s-grid>
      <s-paragraph>One-line description of what this guide covers.</s-paragraph>
      <s-paragraph color="subdued">{doneCount} out of {total} steps completed</s-paragraph>
    </s-grid>

    {/* Steps */}
    <s-box borderRadius="base" borderWidth="base" borderColor="base"
           background="base">
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          <s-box padding="small">
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="start">
              <s-stack gap="small-200">
                <s-checkbox label={step.title} checked={step.done}
                            disabled={step.disabled} />
                <s-paragraph color="subdued">{step.description}</s-paragraph>
                {step.cta && !step.done && !step.disabled && (
                  <s-button variant="primary" href={step.cta.href}>
                    {step.cta.label}
                  </s-button>
                )}
              </s-stack>
            </s-grid>
          </s-box>
          {i < steps.length - 1 && <s-divider />}
        </Fragment>
      ))}
    </s-box>
  </s-grid>
</s-section>
```

## 13. Pattern: Index table (list view)

From Shopify's `index-table` composition.

```tsx
<s-section padding="none" accessibilityLabel="Offers">
  <form method="get">
    <s-table paginate hasPreviousPage={p > 1} hasNextPage={p < pages}
             onPreviousPage={prevPage} onNextPage={nextPage}>
      <s-grid slot="filters" gap="small-200"
              gridTemplateColumns="1fr auto auto">
        <s-search-field label="Search offers"
                        labelAccessibilityVisibility="exclusive"
                        name="q" placeholder="Search offers…" />
        <s-select label="Filter"
                  labelAccessibilityVisibility="exclusive"
                  name="filter">
          <s-option value="all">All</s-option>
        </s-select>
        <s-button type="submit" variant="primary">Apply</s-button>
      </s-grid>

      <s-table-header-row>
        <s-table-header listSlot="primary">Name</s-table-header>
        <s-table-header listSlot="secondary">Status</s-table-header>
        <s-table-header format="numeric">Redemptions</s-table-header>
      </s-table-header-row>

      <s-table-body>
        {rows.map((r) => (
          <s-table-row key={r.id}>
            <s-table-cell>
              <s-link href={`/app/offers/${r.id}`}>{r.name}</s-link>
            </s-table-cell>
            <s-table-cell>
              <s-badge tone={r.status === "active" ? "success" : "neutral"}>
                {r.status}
              </s-badge>
            </s-table-cell>
            <s-table-cell>{r.redemptions.toLocaleString()}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  </form>
</s-section>
```

Key rules:
- `<s-section padding="none">` — let the table own the edges.
- `<form method="get">` wraps the table so server-side filters submit
  natively.
- `<s-grid slot="filters">` is a DIRECT child of `<s-table>`; React treats
  the `slot` attribute as a DOM attribute.
- `listSlot="primary"` on the main column; `"secondary"` on status/meta;
  `"inline"` for inline-with-primary; `"labeled"` for labeled numeric
  columns.
- `format="numeric"` right-aligns numeric columns.
- Built-in pagination props (`paginate`, `hasPreviousPage`, `hasNextPage`,
  `onPreviousPage`, `onNextPage`) wired to `useNavigate`.

## 14. Pattern: Details / edit form

From Shopify's `details` template.

```tsx
<form method="post">
  <s-page heading={offer.name}>
    <s-link slot="breadcrumb-actions" href="/app/offers">Offers</s-link>
    <s-button slot="secondary-actions" href={`/app/offers/${id}/delete`}
              tone="critical">Delete</s-button>
    <s-button slot="primary-action" variant="primary" type="submit">Save</s-button>

    <s-section heading="Offer information">
      <s-grid gap="base">
        <s-text-field label="Name" name="name" value={name}
                      labelAccessibilityVisibility="visible" required
                      details="Merchants see this name when browsing offers." />
        <s-text-area label="Description" name="description"
                     labelAccessibilityVisibility="visible" rows={4} />
      </s-grid>
    </s-section>

    <s-section heading="Codes">…</s-section>
  </s-page>
</form>
```

## 15. Accessibility checklist

- Every `<s-section>` has a visible `heading` or explicit
  `accessibilityLabel`.
- Every icon-only `<s-button>` has `accessibilityLabel`.
- Field labels are visible by default; only hide via `labelAccessibilityVisibility="exclusive"` when the surrounding context already names them (e.g. search icon + placeholder in a filter bar).
- Error messages are specific and actionable — say what's wrong and how
  to fix it.
- Headings describe the section content ("Customer details", not
  "Details").

## 16. Common mistakes (caught in reviews on this project)

| Mistake | Fix |
|---|---|
| `<s-section heading="Name">` containing only `<s-text-field label="Name">` | Use a descriptive section ("Offer information") containing related fields, not a wrapper for a single input. |
| Plain `"✓"` / `"□"` text for checklists | Use `<s-checkbox>` in the setup-guide pattern. |
| `<s-text>` for multi-line descriptions | Switch to `<s-paragraph>`. |
| Actions at the bottom of `<s-page>` | Move to `slot="primary-action"` / `slot="secondary-actions"`. |
| `<s-button variant="primary">` toggled to mimic tabs | Keep tabs as navigation — use a real tab pattern or remove the tabs and show content directly. |
| Duplicated labels inside a table row (`WELCOME20  WELCOME20 · …`) | The `<s-checkbox label>` OR the description repeats — pick one and make the other a subduedparagraph. |
| Everything stacking in one column | Wrap multi-field groups in `<s-grid gap="base">`. For label+action rows use `<s-grid gridTemplateColumns="1fr auto">`. |
| `inline-size="small"` | Use camelCase `inlineSize="small"` — JSX types are camelCase even though the rendered attribute is kebab. |
| `<s-text color="subdued">` used for help text below a field | Use the field's `details` prop. |

---

When adding a new page, open the Shopify template that matches (Homepage,
Details, Index, Settings) at
https://shopify.dev/docs/api/app-home/patterns/templates and mirror its
structure.
