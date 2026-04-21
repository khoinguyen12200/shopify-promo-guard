# Promo Guard — Admin UI Spec

What the merchant sees and clicks, page by page. Optimized for "easiest possible install and daily use."

---

## 1. Design principles

1. **Opinionated by default.** Smart defaults for every setting. Merchants only make the decisions that change product behaviour meaningfully.
2. **Familiar to Shopify.** Match the native Shopify admin look (Polaris web components, s-page / s-card / s-button) so merchants feel at home.
3. **Progressive disclosure.** Advanced options (salt rotation, retention) live in a separate Settings page. The main flow has no settings UI.
4. **Empty states are action-driven.** No "you have no data yet" walls — every empty state has a CTA that creates value.
5. **State before chrome.** Every page shows the current state at a glance (Active / Inactive / Flagged). Actions are secondary to understanding.
6. **Copy is direct.** No marketing, no jargon. "Block their checkout" not "Implement enforcement rule."

---

## 2. Route map (Remix app, embedded inside Shopify admin)

```
/app                                    → redirects: no offers → /app/onboarding, else → /app/offers
/app/onboarding                         first-run checklist
/app/offers                             main page — list of protected offers
/app/offers/new                         create form (pick from existing Shopify discounts)
/app/offers/:id                         detail page (stats + recent blocks)
/app/offers/:id/edit                    edit form (same shape as /new)
/app/offers/:id/delete                  destructive action (confirm modal)
/app/flagged                            flagged orders triage list
/app/settings                           salt rotation, retention, uninstall cleanup info
```

Plus the **admin UI extension** rendered as a block on Shopify's native Order Details page (`admin.order-details.block.render`). Not a Remix route — ships as a separate extension.

---

## 3. First run — `/app/onboarding`

What loads immediately after install finishes OAuth.

```
┌─ Promo Guard ─────────────────────────────────────────────────────┐
│                                                                    │
│   Welcome to Promo Guard                                           │
│   Stop abusers from redeeming your welcome offers twice.           │
│                                                                    │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │  ☑  Connect your store                                     │  │
│   │  ☐  Protect a discount                                     │  │
│   │      We found 3 discounts that look like welcome offers.   │  │
│   │      [  Pick one →  ]                                       │  │
│   │  ☐  Turn on checkout protection                            │  │
│   │      Required for blocking to work.                        │  │
│   └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│   Skip onboarding — I'll set it up later                           │
└────────────────────────────────────────────────────────────────────┘
```

- On **"Pick one →"** → navigates to `/app/offers/new` with the suggested discounts pre-selected.
- On **Skip** → navigates to `/app/offers` (empty state).
- Once the merchant creates their first offer, onboarding is permanently dismissed.

If auto-suggest finds nothing, the second checklist item says "Create your first protected offer" and goes to `/app/offers/new` with an empty form.

---

## 4. Offers list — `/app/offers`

The main page.

### Empty state (no offers yet)

```
┌─ Protected Offers ─────────────────────────── [+ New protected offer] ┐
│                                                                        │
│   No protected offers yet.                                             │
│                                                                        │
│   Protect your welcome discount so it can only be used once per        │
│   customer — even if they try a new email.                             │
│                                                                        │
│                          [ Create your first offer → ]                 │
└────────────────────────────────────────────────────────────────────────┘
```

### With offers

```
┌─ Protected Offers ─────────────────────────── [+ New protected offer] ┐
│                                                                        │
│   Welcome program                                          Active      │
│   WELCOME10                                                            │
│   204 redemptions this month · 37 blocked · 12 flagged                 │
│                                                                        │
│   ─────────────────────────────────────────────────────────────────    │
│                                                                        │
│   Free sample                                              Inactive    │
│   SAMPLE                                                                │
│    89 redemptions this month ·  0 blocked                              │
│                                                                        │
│   ─────────────────────────────────────────────────────────────────    │
│                                                                        │
│   12 orders need your review                 [ Review flagged → ]     │
└────────────────────────────────────────────────────────────────────────┘
```

Each row clickable → `/app/offers/:id`.

Status badge colors:
- **Active** — green
- **Inactive** — grey
- **Needs activation** — amber (offer where merchant hasn't flipped the Checkout Rules switch yet)

Bottom banner appears when `FlaggedOrder.merchantAction = "pending"` count > 0 anywhere in the shop.

### Status "Needs activation" (nudge)

```
┌─ Welcome program                              Needs activation  ──────┐
│  WELCOME10                                                             │
│                                                                        │
│  ⚠  Your Checkout Rule isn't turned on yet. Your offer isn't being    │
│     protected — abusers can still redeem it.                          │
│                                                                        │
│                          [ Open Checkout Rules → ]                     │
└────────────────────────────────────────────────────────────────────────┘
```

Deep links to `https://admin.shopify.com/store/<domain>/settings/checkout/rules`. We detect activation via our app polling the validation's state via Admin GraphQL (`validations` query) every few minutes, or when the merchant returns to our app.

---

## 5. Create offer — `/app/offers/new`

Loaded fresh OR pre-populated from onboarding.

One code per offer. We never create or modify discount codes ourselves — the merchant creates discounts in Shopify; we just pick which one to protect. When a checkout uses the protected code and matches a prior redemption, our validation function blocks it.

### Full form

```
┌─ New protected offer ─────────────────────────────────────────────────┐
│                                                                        │
│   Name                                                                 │
│   [ Welcome program                                                 ]  │
│                                                                        │
│   ── Which code does this welcome offer protect? ──                   │
│                                                                        │
│   Discount code                                                        │
│   [ welcome                                                  🔍 ]      │
│   ┌────────────────────────────────────────────────────────────┐      │
│   │ WELCOME10                                                  │      │
│   │ 10% off · once per customer · active                       │      │
│   ├────────────────────────────────────────────────────────────┤      │
│   │ WELCOMEBACK                                                │      │
│   │ 15% off · scheduled                                        │      │
│   └────────────────────────────────────────────────────────────┘      │
│                                                                        │
│   Don't see your code? Create it in Shopify, then come back —         │
│   the list refreshes automatically.                                    │
│   [ Create a discount in Shopify ↗ ]                                   │
│                                                                        │
│                                   [ Cancel ]   [ Create offer → ]    │
└────────────────────────────────────────────────────────────────────────┘
```

After picking, the input collapses to a chip with a remove button:

```
┌─ Which code does this welcome offer protect? ───────────────────────┐
│                                                                      │
│   [ WELCOME10 ]  [ × ]                                               │
│                                                                      │
│   One code per protected offer. Remove this one to pick a different. │
└──────────────────────────────────────────────────────────────────────┘
```

### "Create a discount in Shopify"

Always visible below the search field (regardless of whether the merchant's store has any discount codes). Opens `https://admin.shopify.com/store/<domain>/discounts/new` in a new tab.

### Auto-refresh

When the merchant returns to our tab (e.g. after creating a discount in Shopify), we re-query their discount codes and update the dropdown options. Implementation: a `visibilitychange` listener on the picker component re-runs the loader fetcher when the tab becomes visible.

### Form errors

Inline, below the field, red:

- "Pick a code."
- "This code is already in another protected offer ("X"). Pick a different code."
- "We couldn't read that discount from your store. Try again."

---

## 6. Offer detail — `/app/offers/:id`

```
┌─ Welcome program ─────────── [ Pause ]  [ Edit ]  [ Delete ] ────────┐
│                                                                       │
│   Status: Active                                                      │
│   Code:   WELCOME10                                                   │
│   Created Apr 17, 2026                                                │
│                                                                       │
│   ┌─ Last 30 days ────────────────────────────────────────────────┐  │
│   │    204   redemptions                                           │  │
│   │     37   blocked at checkout                                   │  │
│   │     12   flagged for review                                    │  │
│   │                                                                │  │
│   │   Top matched signals:                                          │  │
│   │     shipping address (22)                                       │  │
│   │     phone (11)                                                  │  │
│   │     email (similar) (4)                                         │  │
│   └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│   ┌─ Recent blocks ───────────────────────────────────────────────┐  │
│   │   Apr 17  13:42   phone match                                 │  │
│   │   Apr 17  11:08   address match                               │  │
│   │   Apr 17  09:51   similar email match                         │  │
│   │                                                                │  │
│   │   [ View all → ]                                               │  │
│   └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│   ┌─ Flagged orders (12) ─────────────────────────────────────────┐  │
│   │   Orders that got through checkout but matched a prior        │  │
│   │   redemption. Review and decide whether to cancel.            │  │
│   │                                                                │  │
│   │   [ Review flagged orders → ]                                  │  │
│   └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

- **Activate / Deactivate** button toggles `status` between `"active"` and `"inactive"`. Deactivating drops the offer's bucket from the shard so the checkout validator stops scoring against it; if no active offers remain, the entire Shopify validation is disabled via `validationUpdate(enable: false)`.
- **Block / Watch toggle** flips `mode` between `"block"` and `"watch"` and rewrites the bucket's mode flag in the shard. Watch mode lets the checkout proceed but still flags abusers post-order so the merchant can review.
- **Edit** → `/app/offers/:id/edit`.
- **Delete** → confirm modal, then archive the protected offer (soft delete — `archivedAt = now`). The merchant's discount code in Shopify is untouched.

### Delete confirmation

```
┌─ Delete "Welcome program"? ──────────────────────────────────────────┐
│                                                                       │
│   The protected offer will be removed from Promo Guard.               │
│   Your discount code in Shopify (WELCOME10) is not affected —         │
│   abusers will be able to redeem it again.                            │
│                                                                       │
│                            [ Cancel ]   [ Delete ]                   │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 7. Flagged orders — `/app/flagged`

Triage list for merchant review.

```
┌─ Flagged orders ───────────────────────── Filter: All · 30 days ─────┐
│                                                                       │
│   #1042   jane@example.com        $48.90    HIGH   Apr 17  10:42     │
│           Phone + address match prior redemption                      │
│           [ Dismiss ]  [ Cancel order → ]                             │
│                                                                       │
│   #1041   mark@example.com        $22.00   MEDIUM  Apr 17  09:15     │
│           Similar email to prior redemption                           │
│           [ Dismiss ]  [ Cancel order → ]                             │
│                                                                       │
│   #1039   lee+promo@example.com   $68.00    HIGH   Apr 16  22:51     │
│           Email match prior redemption #1234                          │
│           [ Dismiss ]  [ Cancel order → ]                             │
│                                                                       │
│   Load more ↓                                                         │
└───────────────────────────────────────────────────────────────────────┘
```

Actions:

- **Dismiss** → sets `FlaggedOrder.merchantAction = "dismissed"`. Removes from default view. Our app doesn't touch the order itself.
- **Cancel order** → deep-links to Shopify's native order cancel flow. Our app marks `FlaggedOrder.merchantAction = "cancelled"` when it later detects the order's cancelled status via webhook.

Filter pill: `All · Pending · Dismissed · Cancelled`. Default view is Pending.

### Empty state

```
┌─ Flagged orders ─────────────────────────────────────────────────────┐
│                                                                       │
│   No flagged orders yet.                                              │
│                                                                       │
│   Orders get flagged when they match a prior redemption of a          │
│   protected offer. You'll see them here for review.                   │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 8. Admin UI extension — order details block

On **Shopify's native Order Details page** (not inside our app), we render a block that surfaces the flag contextually.

Target: `admin.order-details.block.render`.

```
┌─ Promo Guard ──────────────────────────────────── [ Hide ] ─────────┐
│                                                                      │
│   🚩 Flagged: HIGH                                                   │
│                                                                      │
│   This order matched a prior welcome-offer redemption.               │
│                                                                      │
│     • Phone matches order #1234                                      │
│     • Shipping address matches order #1234                           │
│                                                                      │
│   Offer: Welcome program                                             │
│   Codes used: WELCOME10                                              │
│                                                                      │
│                   [ Dismiss ]   [ Cancel this order → ]             │
└──────────────────────────────────────────────────────────────────────┘
```

If the order is NOT flagged by us, the block renders nothing (collapses to zero-height) — merchant doesn't see it.

Uses `@shopify/ui-extensions/admin` Preact components: `s-admin-block`, `s-stack`, `s-badge`, `s-text`, `s-button`. Fetches the FlaggedOrder row via our app's bridge using Admin GraphQL extension capability.

---

## 9. Settings — `/app/settings`

Intentionally sparse.

```
┌─ Settings ───────────────────────────────────────────────────────────┐
│                                                                       │
│   ── Data retention ──                                                │
│   Keep redemption history for:                                        │
│     ◉ 2 years (recommended)                                           │
│     ○ 1 year                                                          │
│     ○ 6 months                                                        │
│                                                                       │
│   ── Reset all detection ──                                           │
│   ⚠  This clears the protection ledger for all offers. Future         │
│   redemptions start fresh. Prior abusers won't be recognized.         │
│                                                                       │
│                                  [ Rotate salt and reset ledger ]     │
│                                                                       │
│   ── Uninstall ──                                                     │
│   When you uninstall Promo Guard, we keep your data for 48 hours      │
│   in case you reinstall, then delete everything permanently.          │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

No other knobs. Scoring weights, thresholds, signal checkboxes — all hidden.

---

## 10. Global navigation

Top-left app nav (inside the embedded frame):

```
Promo Guard
  Offers            ← default landing
  Flagged orders    ← badge shows pending count
  Settings
```

Mirrors Shopify admin nav style. No icons — text only, matches Shopify's nav density.

---

## 11. Loading, error, and success states

### Loading (page-level)

Polaris skeleton components on every page render while data is fetching. Never blank.

```
┌─ Protected Offers ───────────────────────────── [+ New protected offer] ┐
│                                                                          │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                                             │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                                                     │
│   ▓▓▓▓▓▓▓▓▓▓▓▓                                                          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Error — API unreachable

```
┌─ Couldn't load your offers ──────────────────────────────────────────┐
│                                                                       │
│   We're having trouble reaching Shopify. Usually this clears up       │
│   in a few seconds.                                                   │
│                                                                       │
│                               [ Try again ]                           │
└───────────────────────────────────────────────────────────────────────┘
```

### Success — toast via Shopify App Bridge

```
 Offer "Welcome program" created.        [ View ]   [ × ]
```

Auto-dismisses after 4s. `shopify.toast.show("Offer created", { action: { label: "View", onAction: ... }})`.

---

## 12. Copy style

- **Sentence case.** "New protected offer" not "New Protected Offer."
- **Active voice, second person.** "Your offer isn't being protected" not "The offer is unprotected."
- **No exclamation marks** except in the admin UI extension's "🚩" indicator.
- **Numbers matter.** "204 redemptions" not "Many redemptions."
- **No hedging.** "Block their checkout" not "Optionally block the checkout."
- **No Shopify jargon** in merchant-facing text — never say "validation function," "webhook," "metaobject." Internally in error messages, prefix with "Debug:" if we have to surface it.

---

## 13. Accessibility

- Every action has a keyboard path. `Tab` to reach, `Space`/`Enter` to activate.
- Polaris components are WCAG AA by default. Don't override their contrast or focus styles.
- Status badges use color + text (not color alone).
- Screen-reader labels on every icon button (e.g., the code "×" chip).
- Error messages are announced via `aria-live="polite"`.

---

## 14. Performance

- Offers list: under 200 ms first paint on a shop with ≤ 20 offers. Data fetched via loader, shown with skeleton.
- Flagged orders list: paginated at 25/page. Virtualize if we ever exceed 500 visible rows.
- Create form with auto-suggest: fetches discounts in parallel with render; list populates in a section that shows a skeleton until ready.

---

## 15. File layout

```
app/
  routes/
    app._index.tsx
    app.onboarding.tsx
    app.offers._index.tsx
    app.offers.new.tsx
    app.offers.$id._index.tsx
    app.offers.$id.edit.tsx
    app.offers.$id.delete.tsx
    app.flagged._index.tsx
    app.settings.tsx
  components/
    offer-list-row.tsx
    offer-form.tsx
    code-picker.tsx              ← auto-suggest checkbox list + "Create in Shopify" link
    flagged-order-row.tsx
    setup-checklist.tsx
    stats-card.tsx
    activation-nudge.tsx          ← the "Needs activation" banner
  lib/
    discount-query.server.ts      ← query existing discounts for auto-suggest
    offer-service.server.ts       ← status flips, name updates, soft-archive on delete
    format.ts                     ← date + money formatters

extensions/
  promo-guard-order-block/        ← admin UI extension (separate bundle)
    shopify.extension.toml
    src/
      OrderBlock.tsx
```

---

## 16. What we're NOT building in MVP

| Feature | Why skipped |
|---|---|
| Charts / time-series graphs | Numbers are enough; graphs invite configuration |
| Per-offer custom error messages | Default message covers 95% of cases |
| Scheduled reports / weekly email digests | Merchant can bookmark the flagged page |
| Multi-user permissions within our app | Shopify admin already has staff permissions |
| Silent / strip-discount mode | Tested in early prototype — couldn't reliably detect abuse from the discount-function context. Block (validation function) is the only enforcement path. |
| Inline discount creation in our app | Merchants create discounts in Shopify; we only protect existing ones. |
| Mobile-specific layouts | Polaris components handle this — we don't add custom responsive logic |
| Onboarding video | Copy + empty-state CTAs are sufficient |

---

## 17. Future (post-MVP) enhancements

- **Weekly summary card** on the offers list: "42 blocks this week · 12 flagged · 3 HIGH."
- **Signal contribution chart** per offer (donut: phone 50%, address 30%, email 15%, IP 5%).
- **Bulk triage** on flagged orders (select all → dismiss all).
- **Allowlist**: merchant marks specific customers as "never flag."
- **Per-offer retention override** when a particular offer's noise profile differs.

None of these change the MVP surface. All can be added without rework.
