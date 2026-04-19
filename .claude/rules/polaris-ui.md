---
paths:
  - "app/components/**/*.tsx"
  - "app/routes/app.*.tsx"
  - "app/routes/admin.*.tsx"
---

# Shopify Polaris UI Standards

Full reference: @docs/polaris-standards.md

## Quick checklist before touching any UI file

- Use `<s-*>` web components only — never `@shopify/polaris` React lib, never raw `<input>`/`<select>`/`<textarea>`
- Props are camelCase JSX (`inlineSize`, not `inline-size`)
- Spacing tokens only from the approved scale (`none` / `small-*` / `base` / `large-*`)
- Every `<s-section>` needs a descriptive `heading` or `accessibilityLabel`
- Every icon-only `<s-button>` needs `accessibilityLabel`
- Page actions go in `slot="primary-action"` / `slot="secondary-actions"` — never at the bottom
- `<form>` wraps `<s-page>`, not the other way around

## Component quick-pick

| Need | Use |
|---|---|
| Block-level description / help text | `<s-paragraph>` |
| Inline text styling | `<s-text>` |
| Multi-option radio group | `<s-choice-list>` + `<s-choice>` |
| Standalone boolean | `<s-checkbox>` |
| Immediate on/off toggle | `<s-switch>` |
| Label + action side-by-side | `<s-grid gridTemplateColumns="1fr auto">` |
| Responsive card row | `<s-grid gap="base" gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))">` |
| Generic visual container | `<s-box>` (not `<s-section>` — that's for heading groups) |

## Patterns to follow exactly (see §11–14 in polaris-standards.md)

- **Metrics card** — `<s-box>` outer, `<s-heading>` for label, `<s-text>` for value
- **Setup guide** — `<s-checkbox>` for steps, never `"✓"`/`"□"` characters
- **Index table** — `<s-section padding="none">`, `<form method="get">` wrapper, `slot="filters"` grid
- **Details / edit form** — `<form>` → `<s-page>` → sections; breadcrumb in header slot
