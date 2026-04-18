# Promo Guard — Admin UI Spec

What the merchant sees and clicks, page by page. Optimized for "easiest possible install and daily use."

---

## 1. Design principles

1. **Opinionated by default.** Smart defaults for every setting. Merchants only make the decisions that change product behaviour meaningfully.
2. **Familiar to Shopify.** Match the native Shopify admin look (Polaris web components, s-page / s-card / s-button) so merchants feel at home.
3. **Progressive disclosure.** Advanced options (salt rotation, retention) live in a separate Settings page. The main flow has no settings UI.
4. **Empty states are action-driven.** No "you have no data yet" walls — every empty state has a CTA that creates value.
5. **State before chrome.** Every page shows the current state at a glance (Active / Paused / Flagged). Actions are secondary to understanding.
6. **Copy is direct.** No marketing, no jargon. "Block their checkout" not "Implement enforcement rule."

---

## 2. Route map (Remix app, embedded inside Shopify admin)

```
/app                                    → redirects: no offers → /app/onboarding, else → /app/offers
/app/onboarding                         first-run checklist
/app/offers                             main page — list of protected offers
/app/offers/new                         create form (auto-suggest + manual)
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
│   │      (only needed for block mode — skipped for now)        │  │
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
│   WELCOME10 · WELCOME15 · NEWBIE                                       │
│   204 redemptions this month · 37 blocked · 12 flagged                 │
│                                                                        │
│   ─────────────────────────────────────────────────────────────────    │
│                                                                        │
│   Free sample                                              Paused      │
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
- **Paused** — grey
- **Needs activation** — amber (block mode offer where merchant hasn't flipped the Checkout Rules switch yet)

Bottom banner appears when `FlaggedOrder.merchantAction = "pending"` count > 0 anywhere in the shop.

### Status "Needs activation" (nudge)

```
┌─ Welcome program                              Needs activation  ──────┐
│  WELCOME10 · WELCOME15                                                 │
│                                                                        │
│  ⚠  You chose Block mode, but the Checkout Rule isn't turned on yet.  │
│     Your offer isn't being protected.                                  │
│                                                                        │
│  [ Open Checkout Rules → ]   or   switch to silent mode               │
└────────────────────────────────────────────────────────────────────────┘
```

Deep links to `https://admin.shopify.com/store/<domain>/settings/checkout/rules`. We detect activation via our app polling the validation's state via Admin GraphQL (`validations` query) every few minutes, or when the merchant returns to our app.

---

## 5. Create offer — `/app/offers/new`

Loaded fresh OR pre-populated from onboarding.

### Full form

```
┌─ New protected offer ─────────────────────────────────────────────────┐
│                                                                        │
│   Name                                                                 │
│   [ Welcome program                                                 ]  │
│                                                                        │
│   ── Which codes count as this welcome offer? ──                      │
│                                                                        │
│   Suggested (one per customer):                                        │
│   ☑ WELCOME10       10% off · once per customer · active              │
│   ☑ NEWBIE          Free shipping · once per customer · active        │
│   ☐ FIRST20         $20 off · once per customer · inactive            │
│                                                                        │
│   Other welcome-style codes:                                           │
│   ☐ WELCOME15       15% off · seasonal · ended 2024-12                │
│   ☐ SIGNUP5         $5 off · active                                   │
│                                                                        │
│   Or add a code manually:                                              │
│   [ code name                                          ]   [ Add ]     │
│                                                                        │
│   Selected:                                                            │
│   [ WELCOME10 × ]  [ NEWBIE × ]                                        │
│                                                                        │
│   ── What happens when someone reuses this offer? ──                  │
│                                                                        │
│   ◉  Silently don't apply the discount          (recommended)         │
│      The customer can still check out — they just don't get the       │
│      discount. Works best for most stores.                             │
│                                                                        │
│   ○  Block their checkout                                              │
│      Stops the checkout with an error message. Stronger, but can      │
│      frustrate legitimate customers.                                  │
│                                                                        │
│                                   [ Cancel ]   [ Create offer → ]    │
└────────────────────────────────────────────────────────────────────────┘
```

### Manual code input — two cases

**Case A: code exists** (we queried it successfully). Added to the selected list with its details.

**Case B: code doesn't exist**:

```
┌─ No code called "WELCOMEBACK" exists ──────────────────────────────┐
│                                                                     │
│  Create it through Promo Guard?                                     │
│                                                                     │
│  Amount:   (•) Percentage   [ 10 ]%                                │
│            ( ) Fixed amount                                         │
│                                                                     │
│  Usage:    ☑ Once per customer                                      │
│            ☐ Expire on  [ YYYY-MM-DD ]                             │
│                                                                     │
│                                        [ Cancel ]   [ Create → ]   │
└─────────────────────────────────────────────────────────────────────┘
```

On confirm → create via `discountCodeAppCreate` with our Discount Function ID, then add to the selected list.

### Silent-strip + existing code → confirmation modal

Appears on submit if mode is silent-strip AND any selected code is pre-existing native discount:

```
┌─ Replace your existing discount? ────────────────────────────────────┐
│                                                                       │
│   To silently skip the discount for abusers, we need to replace       │
│   WELCOME10 and NEWBIE with protected versions.                       │
│                                                                       │
│   ✓  Codes stay the same — links in your emails keep working          │
│   ✓  Discount amount, minimum, dates, limits all copied               │
│   ✓  Old discounts are archived (you can restore them anytime)        │
│   ⚠  Analytics for these codes reset                                  │
│                                                                       │
│                         [ Cancel ]    [ Replace & protect → ]        │
└───────────────────────────────────────────────────────────────────────┘
```

### Form errors

Inline, below the field, red:

- "Pick at least one code."
- "This code is already in another protected offer. Remove it from 'X' first."
- "We couldn't read that discount from your store. Try again."

---

## 6. Offer detail — `/app/offers/:id`

```
┌─ Welcome program ─────────── [ Pause ]  [ Edit ]  [ Delete ] ────────┐
│                                                                       │
│   Status: Active · Silent strip                                       │
│   Codes:  WELCOME10 · WELCOME15 · NEWBIE                              │
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

- **Pause** button sets `status = "paused"`. Validation/Discount Functions stop acting on this offer (they read the config metafield at runtime and skip if `status != "active"`).
- **Edit** → `/app/offers/:id/edit`.
- **Delete** → confirm modal. On confirm: if the offer replaced native discounts, offer to restore them. Then archive the protected offer (soft delete — `archivedAt = now`).

### Delete confirmation (with restore option)

```
┌─ Delete protected offer? ────────────────────────────────────────────┐
│                                                                       │
│   Welcome program uses 2 discounts that we created for you            │
│   (WELCOME10, NEWBIE). Deleting this protected offer will:            │
│                                                                       │
│   ○  Restore your original WELCOME10 and NEWBIE                       │
│      (unprotected, native Shopify versions from before)               │
│                                                                       │
│   ◉  Delete the codes entirely                                        │
│      Links using these codes will stop working.                       │
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
- **Active voice, second person.** "You chose Block mode" not "Block mode has been selected."
- **No exclamation marks** except in the admin UI extension's "🚩" indicator.
- **Numbers matter.** "204 redemptions" not "Many redemptions."
- **No hedging.** "Silently don't apply the discount" not "Optionally withhold the discount."
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
    code-picker.tsx              ← auto-suggest + manual entry
    replace-in-place-modal.tsx
    flagged-order-row.tsx
    setup-checklist.tsx
    stats-card.tsx
    activation-nudge.tsx          ← the "Needs activation" banner
  lib/
    discount-query.server.ts      ← query existing discounts for auto-suggest
    offer-service.server.ts       ← create/update/delete offer, handle replace-in-place
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
| A/B testing different modes per offer | Out of scope |
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
