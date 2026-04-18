# Promo Guard — System Design

Prevent repeat abuse of one-time offers (welcome discounts, samples) by matching customer identity signals beyond email.

Works on regular Shopify plans (Basic / Shopify / Advanced). Shopify Starter excluded. Shopify Plus not required.

---

## What the merchant does (whole setup)

1. Install the app.
2. Pick which discount codes to protect. Auto-suggested from the shop's existing discounts. Can also type a code manually (existing or brand-new).
3. Pick the action: **silently don't apply** the discount, or **block checkout**.
4. (Block mode only) Flip the switch in Shopify admin under **Settings > Checkout > Checkout Rules**.

No thresholds, no signal checkboxes, no strictness sliders.

---

## Core concept: protected offer

A **protected offer** = a group of one or more discount codes treated as one welcome program, plus a mode (silent or block). A customer who redeems any code in the group can't redeem any of them again.

Example: `WELCOME10`, `WELCOME15`, `NEWBIE`, `FIRST20` → one "Welcome program" protected offer, one shared ledger.

Most stores have one protected offer. Some have a few (per channel, per market).

---

## How abuse is detected

Same scoring logic runs at checkout and post-order. Each matched signal contributes weight. Score ≥ 10 → action.

| Signal | Weight | Where it runs |
|---|---|---|
| Phone exact (E.164) | **10** | checkout + post-order |
| Email canonical exact (Gmail-normalized) | **10** | checkout + post-order |
| Email MinHash similarity ≥ 0.4 | **6** | checkout + post-order |
| Email MinHash similarity ≥ 0.15 | **4** | checkout + post-order |
| Address full exact (normalized) | **10** | checkout + post-order |
| Address MinHash ≥ 0.3 (road + house bucket + zip) | **6** | checkout + post-order |
| Address street+zip (road + zip only) | **4** | checkout + post-order |
| Customer tag `promo-guard-redeemed` (prior redemption while logged in, any offer on this shop) | **10** | checkout + post-order |
| IP `/24` match | **2** | post-order only |

### Action thresholds

- **Score ≥ 10** → block checkout (Validation mode) or silently withhold discount (Discount mode)
- **Score 4–9** → post-order: flag MEDIUM risk
- **Score ≥ 10** → post-order: flag HIGH risk
- **Score < 4** → no action

### What counts as "prior redemption"

The ledger holds **only orders where one of the protected codes was applied**. Returning customers who never used the welcome offer are not in the ledger — their score is 0, they get the discount cleanly.

---

## Verified Shopify Function limits

These shaped the architecture and must not be violated:

| Limit | Value | Impact |
|---|---|---|
| Function input total | 128 KB | Tight but workable |
| **Individual metafield value seen by Function** | **10,000 bytes** | **Hard ceiling on ledger shards** |
| Input query cost budget | 30 | Each metafield read costs 3 → max ~10 metafield reads |
| Execution budget | 11 M instructions | Plenty for MinHash scans |
| Compiled binary | 256 KB | Our Rust fits |
| Runtime linear memory | 10 MB | Plenty |
| Function output | 20 KB | Plenty |

The 10 KB per-metafield limit is the binding constraint. It forces a sharded, recency-bounded ledger design.

---

## Sharded ledger (checkout read surface)

The Function reads **five shop metafields** per protected offer, each ≤ 10 KB. Together they hold the *most recent* fingerprints of the ledger. Older history stays in Prisma for authoritative post-order scoring.

```
shop.metafields under namespace $app.pg_<offer_id>:

  phones            JSON: [<u32 hash>, ...]                     ≤ 10 KB
  emails_exact      JSON: [<u32 hash>, ...]                     ≤ 10 KB
  emails_minhash    JSON: [<4 × u16 sketch>, ...]               ≤ 10 KB
  addrs_exact       JSON: [<u32 hash>, ...]                     ≤ 10 KB
  addrs_minhash     JSON: [<4 × u16 sketch>, ...]               ≤ 10 KB
```

Query cost: 5 reads × 3 = 15 (under budget 30).

### Capacity by signal

| Shard | Bytes per entry | Entries per 10 KB shard |
|---|---|---|
| phones / emails_exact / addrs_exact | 4 (u32 hash) | ~2,500 |
| emails_minhash / addrs_minhash | 16 (4 × u32 sketch) | ~625 |

### Recency coverage

At typical store volumes, the Function sees this much history:

| Redemptions / month | Exact-match coverage | MinHash coverage |
|---|---|---|
| 100 | ~2 years | ~6 months |
| 500 | ~5 months | ~6 weeks |
| 2,000 | ~6 weeks | ~10 days |
| 10,000 | ~1 week | ~2 days |

Good enough for catching repeat abuse, which typically strikes within days or weeks of the first redemption. Anything older still lives in Prisma and surfaces in the post-order flag.

### Eviction policy

Each shard is a rolling-window of the most recent entries. When a new redemption pushes a shard past 10 KB, the oldest entries fall off. Post-order flagging always uses the full Prisma history, so nothing is truly "lost" — it's just not checkable at checkout speed.

---

## Architecture

```
  Shopify orders/paid webhook  (reliable, fires after payment)
        │
        ▼
  App backend (Remix + Prisma)
    - Was the order's discount one of our protected codes?
       yes → continue, no → ignore
    - Normalize email, phone, shipping address, IP
    - Compute exact hashes + MinHash sketches
    - Insert RedemptionRecord row in Prisma (full history)
    - Append hashes to sharded metafields, evict oldest if >10 KB
    - If customer is logged in → tagsAdd promo-guard-redeemed (shop-wide)
    - Run authoritative scoring against Prisma (all signals incl. IP)
    - If score ≥ 10 → orderRiskAssessmentCreate HIGH + tag + notify
    - If score 4-9 → orderRiskAssessmentCreate MEDIUM + tag
        │
        ▼
  Shop metafield  (one shop-wide shard: namespace="promo_guard" key="shard_v1")

──── checkout ─────────────────────────────────────────

  Validation Function  OR  Discount Function
    input query:
      cart.buyerIdentity.email, phone
      cart.deliveryGroups.deliveryAddress
      cart.customer.hasAnyTag(["promo-guard-redeemed"])
      shop.metafield("promo_guard", "shard_v1")   // combined parallel arrays
    Rust logic:
      if no cart.discountCodes matches this offer's group → return allow
      normalize incoming signals
      compute exact hash + MinHash sketch
      scan 5 shards, sum weighted score
      score ≥ 10 → validationAdd  /  return empty discount operations
      else → allow (post-order will catch misses)
```

### Why `orders/paid` not `orders/create`

Shopify's docs warn: *"the orders/create webhook might not fire immediately. It's important to ensure that neither of these is required for real-time functionality of your app."* So post-order flagging uses `orders/paid`, which is reliable and fires once payment settles.

---

## Components

| # | Component | Type | Plan | Role |
|---|---|---|---|---|
| 1 | `promo-guard-validator` | Cart & Checkout Validation Function | All | Block mode: `validationAdd` error when score ≥ 10 |
| 2 | `promo-guard-discount` | Discount Function | All | Silent-strip mode: return no operations when score ≥ 10 |
| 3 | App backend (Remix) | — | — | Ledger, fingerprint builder, webhooks, admin pages |
| 4 | `orders/paid` handler | Remix route | All | Write Prisma, update shards, tag customer, create risk assessment |
| 5 | Shop metafields `pg_<offer>_*` (5 shards) | Shop metafields | All | Checkout-readable rolling-window index |
| 6 | Prisma DB | App DB | — | Raw normalized signals, full history, post-order source of truth |
| 7 | Admin UI (Remix pages) | App embed | All | Protected offers, create/edit, flagged orders |
| 8 | Admin UI extension `admin.order-details.block.render` | Extension | All | Custom card on order detail for flagged orders |

### Required OAuth scopes

```
read_orders, write_orders            ← webhooks + risk assessment + tags
read_customers, write_customers      ← customer tag on redemption
read_discounts, write_discounts      ← read existing, create/replace app-owned discounts
read_metafields, write_metafields    ← sharded ledger
```

Plus **protected customer data** approval (levels 1 + 2) for email/phone/address. Request during app submission.

### Webhook topics

`orders/paid`, `app/uninstalled`, plus mandatory compliance (`customers/data_request`, `customers/redact`, `shop/redact`).

---

## Merchant UX

### Onboarding

```
┌─ Setup ───────────────────────────────────────────┐
│  ☑  Connect your store                            │
│  ☐  Protect a discount                            │
│      (we found 3 welcome-style discounts)         │
│  ☐  Turn on checkout protection                   │
│      (only needed for block mode)                 │
└────────────────────────────────────────────────────┘
```

### Protected offers — list view

```
┌─ Protected Offers ─────── [+ New protected offer] ──┐
│  Welcome program   WELCOME10 WELCOME15   Active  ···│
│  204 redemptions · 37 blocked · 12 flagged         │
│                                                      │
│  Free sample       SAMPLE                Active  ···│
│   89 redemptions · 12 blocked ·  3 flagged         │
└──────────────────────────────────────────────────────┘
```

### Create protected offer — smart code picker

Three ways to choose codes, combined in one form:

```
┌─ New protected offer ─────────────────────────────────┐
│                                                        │
│  Which codes count as this welcome offer?             │
│                                                        │
│  ── Suggested (one-time per customer) ──              │
│  ☑ WELCOME10     10% off · once per customer · active │
│  ☑ NEWBIE        Free shipping · once per customer    │
│  ☐ FIRST20       $20 off · once per customer          │
│                                                        │
│  ── Other codes with "welcome-ish" names ──           │
│  ☐ WELCOME15     15% off · no per-customer limit      │
│  ☐ SIGNUP5       $5 off · active                      │
│                                                        │
│  ── Type a code manually ──                           │
│  [ WELCOMEBACK              ]  [+ Add]                │
│  ⓘ We'll find it if it exists, or help you create it │
│                                                        │
│  Selected: [ WELCOME10 ×] [ NEWBIE ×] [ WELCOMEBACK ×]│
│                                                        │
│  ── What happens when someone reuses it? ──           │
│  (•) Silently don't apply the discount                │
│  ( ) Block their checkout                              │
│                                                        │
│                      [ Cancel ]  [ Protect → ]        │
└────────────────────────────────────────────────────────┘
```

### Auto-suggest logic

When the form loads, query the shop's existing discounts and rank them:

1. **Top section — "Suggested"**: discounts with `appliesOncePerCustomer: true` (the strongest signal of a welcome-style discount). Sorted by most-recently active first.
2. **Second section — "Other"**: discounts whose title or code contains `welcome|first|new|signup|sample`, not already in section 1.
3. **Always visible — manual entry**: free-text input.

Query used:

```graphql
codeDiscountNodes(first: 50, sortKey: CREATED_AT, reverse: true) {
  nodes {
    id
    codeDiscount {
      ... on DiscountCodeBasic {
        title
        appliesOncePerCustomer
        status
        codes(first: 5) { nodes { code } }
      }
      ... on DiscountCodeApp {
        title
        appliesOncePerCustomer
        status
      }
    }
  }
}
```

We include **past** codes too (not just active) so historical codes like `WELCOME15` from a past campaign can be added to the ledger via backfill.

### Manual code entry

When the merchant types a code:

- **We find a match** → show its details (amount, status, limit), add to the selected list.
- **No match found** → offer to create it: "No code called `WELCOMEBACK` exists. Create a new one through Promo Guard?" → opens an inline sub-form for amount / percent / dates / limits. We'll register it via `discountCodeAppCreate` with our Discount Function.

### Silent-strip with existing code → replace-in-place

If the merchant picks an existing native discount and chooses silent-strip, we show:

```
┌─ Replace your existing discount? ────────────────┐
│                                                   │
│  To silently skip the discount for abusers, we    │
│  need to replace WELCOME10 with a protected       │
│  version.                                         │
│                                                   │
│   ✓ Code stays "WELCOME10" — links keep working   │
│   ✓ Amount, minimum, dates, limits all copied     │
│   ✓ Old discount is archived (history kept)       │
│   ⚠ Analytics for WELCOME10 start fresh          │
│                                                   │
│              [ Cancel ]  [ Replace & protect → ] │
└───────────────────────────────────────────────────┘
```

On confirm:

1. Read the old discount's full config via `codeDiscountNodeByCode`.
2. **Deactivate the old discount first** via `discountCodeDeactivate` (required — Shopify errors with "must be unique" otherwise).
3. `discountCodeAppCreate` with the same code string + copied config + our Discount Function ID.
4. Archive reference is stored in Prisma so we can restore on uninstall.

Block mode doesn't require replacement — we just attach the Validation Function to watch the code(s).

### Offer detail page

```
┌─ Welcome program ─────────────── [Pause] [Delete] ──┐
│  Status: Active                                      │
│  Codes:  WELCOME10, WELCOME15, NEWBIE                │
│  Mode:   Silently don't apply                        │
│                                                      │
│  ── Last 30 days ──────────────────────────────      │
│  204 redemptions                                     │
│   37 blocked at checkout                             │
│   12 flagged post-order                              │
│                                                      │
│  ── Recent blocks ─────────────────────────────      │
│  Apr 17  13:42   phone match                        │
│  Apr 17  11:08   address match                      │
│                                                      │
│  [ View flagged orders → ]                           │
└──────────────────────────────────────────────────────┘
```

### Flagged orders — post-order surface

Three native Shopify surfaces, populated by the `orders/paid` handler:

1. **Native Risk section** on the order detail via `orderRiskAssessmentCreate`:
   ```
   Risk — Promo Guard · HIGH
     • Phone matches prior redemption on order #1234
     • Similar email (khoi.nguyen@gmail.com ↔ testerkhoi@gmail.com) on order #1234
     • Nearby address as order #1234
   ```

2. **Order tag** `promo-guard-flagged` — filterable in the order list.

3. **Admin UI block** on the order detail (target `admin.order-details.block.render`) with Dismiss / Cancel actions.

Plus our own **Flagged orders** page inside the app for batch triage.

### Global settings (tucked away)

- Rotate per-shop salt (warns: invalidates ledger).
- Uninstall cleanup info.

---

## Cold start — backfill from order history

When the merchant adds codes to a protected offer, we backfill by querying orders that used those codes:

```
for each code in the protected offer:
  paginate admin.orders(query: "discount_code:<code>", first: 250)
  for each order:
    extract signals, compute fingerprints
    insert into Prisma
  append hashes to the 5 sharded metafields (evict oldest beyond 10 KB)
```

Takes seconds for small shops, a few minutes for large ones. Merchant sees a progress bar. Protection is live when the sync for that offer completes.

The `discount_code:X` filter is confirmed available on the GraphQL Admin orders query (max 255 chars, case-insensitive).

---

## Privacy & compliance

- Raw PII lives only in Prisma, salted + encrypted at rest.
- Shop metafields contain only **hashes and MinHash sketches** (irreversible).
- Per-shop salt — hashes can't be correlated across shops.
- Protected customer data: request levels 1 + 2 during app submission.
- Compliance webhooks wire into DB deletion.

---

## Build order

1. Remix app skeleton + Prisma schema + per-shop salt.
2. `shopify.app.toml`: scopes, webhooks (`orders/paid`, compliance), metafield namespace.
3. Normalization + MinHash library (shared spec between Node and Rust).
4. `orders/paid` handler — Prisma write, shard update, customer tag, authoritative scoring, risk assessment.
5. Validation Function (Rust) — reads 5 metafield shards, computes score, returns error on ≥ 10.
6. Discount Function (Rust) — same scoring, returns empty operations instead.
7. Admin UI: protected-offers list, create form with auto-suggest + manual entry + create-new sub-form.
8. Replace-in-place flow with deactivate-first ordering.
9. Admin UI: flagged orders page + admin block on order detail.
10. Cold-start backfill job with progress indicator.
11. Submit for protected customer data approval (levels 1 + 2).

---

## Out of scope

- Blocking the very first redemption (ledger is empty for that buyer).
- Fighting sophisticated attackers who change phone + email + address + account + IP — no reasonable app catches this without invasive device fingerprinting.
- Cross-shop detection — ledger is per-shop.
- Plus-only enhancements: in-checkout UI on info/shipping/payment steps, live network lookups via Function `fetch` target.

---

## Known trade-offs (honest)

| Trade-off | Why acceptable |
|---|---|
| Checkout only sees recent history (rolling window) | Repeat abuse typically strikes within days/weeks; older history caught post-order |
| MinHash can miss very-different emails with same real owner | Combined signals (phone, address) catch most of these |
| MinHash can false-positive on unrelated buyers with overlapping trigrams | Weight of 4 alone doesn't trigger action (threshold is 10) |
| First redemption is never blocked | Ledger must have an entry to match against; this is the bootstrap cost |
| Merchant must manually flip Checkout Rules toggle for block mode | Shopify requires it; we deep-link them there |
| `orders/paid` delay means post-order flag may arrive seconds-to-minutes after purchase | Merchant workflow is review-then-cancel, not real-time |
