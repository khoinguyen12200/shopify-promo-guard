# Promo Guard — Landing Page Spec

The public marketing site. First thing a merchant sees before installing. Goal: **convert the right merchants to click "Install."**

---

## 1. Scope

One public site, unauthenticated, served from our app domain (e.g., `https://promoguard.app`). Hosted as part of the Remix app's public routes, OR as a separate static site — both are acceptable. Recommend the former for MVP (one codebase, one deploy).

**Not in scope**: blog, help center, customer dashboard. Those come later.

---

## 2. Pages

| Route | Purpose |
|---|---|
| `/` | Home — hero, problem, solution, pricing teaser, install CTA |
| `/pricing` | Full pricing table + FAQ |
| `/docs` | Redirects to Shopify App Store listing docs + in-app help |
| `/privacy` | Privacy policy (required for Shopify App Store submission) |
| `/terms` | Terms of service |
| `/security` | How we handle data (required for Level 2 protected customer data approval) |
| `/install` | Handles `?shop=xxx.myshopify.com` parameter and starts the OAuth flow |

---

## 3. Target audience

**Primary ICP (ideal customer profile):**
- Shopify Basic / Shopify / Advanced merchants
- $10k – $5M annual revenue
- Run at least one welcome discount (code or automatic)
- Have seen repeat abuse ("my welcome offer gets redeemed 5 times by one person")

**Not our audience (honest disqualification):**
- Shopify Plus stores with existing custom solutions
- Stores with no welcome offer
- Merchants who need blocking based on IP alone (we don't do that well)

---

## 4. Home page (`/`)

### Hero

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│             Stop welcome-offer abuse before it costs you.             │
│                                                                       │
│   Promo Guard catches repeat redemptions even when the abuser uses   │
│   a new email. Ship in 5 minutes. Works on every Shopify plan.       │
│                                                                       │
│          [ Install on Shopify → ]    [ See how it works ↓ ]          │
│                                                                       │
│              ★★★★★ "Saved us $4,200 the first month"                 │
│                  — a merchant, after beta (will replace)             │
└──────────────────────────────────────────────────────────────────────┘
```

CTA button → `/install` (or directly to Shopify App Store listing once we're live there).

### The problem — one scroll below

```
┌─ You already know this problem ──────────────────────────────────────┐
│                                                                       │
│   Your "WELCOME10" code is supposed to be a one-time welcome.         │
│   But the same person keeps using it.                                 │
│                                                                       │
│     khoi.nguyen@gmail.com   →  WELCOME10 · order #1042               │
│     testerkhoi@gmail.com    →  WELCOME10 · order #1108   (same phone)│
│     k.n@gmail.com           →  WELCOME10 · order #1152   (same addr) │
│                                                                       │
│   Shopify's "one per customer" setting only checks email.            │
│   A new email = a new customer, as far as Shopify is concerned.       │
└───────────────────────────────────────────────────────────────────────┘
```

### How Promo Guard works

```
┌─ 1. Pick the code you want to protect ──────────────────────────────┐
│                                                                      │
│   We auto-suggest your welcome discounts. Pick the ones to guard.    │
│   No changes to how you promote them — same code, same emails.       │
└──────────────────────────────────────────────────────────────────────┘

┌─ 2. Pick what happens when someone tries to reuse ──────────────────┐
│                                                                      │
│   Silently don't apply the discount   (gentle, recommended)          │
│   or                                                                 │
│   Block their checkout with a message  (strict)                      │
└──────────────────────────────────────────────────────────────────────┘

┌─ 3. We catch the patterns you can't see ────────────────────────────┐
│                                                                      │
│   Phone + address + email variations (like khoi.nguyen ↔             │
│   testerkhoi@gmail.com) all feed a single "is this really a new      │
│   customer?" decision.                                                │
│                                                                      │
│   Abusers caught. Legitimate first-time buyers untouched.            │
└──────────────────────────────────────────────────────────────────────┘
```

### Why it's different

A short comparison block showing what we do vs. Shopify native vs. generic fraud apps:

| | Shopify native | Typical fraud app | Promo Guard |
|---|---|---|---|
| Email match | ✓ | ✓ | ✓ |
| Phone match | ✗ | partial | ✓ |
| Address match | ✗ | partial | ✓ |
| Similar emails (same person, different inbox) | ✗ | ✗ | ✓ |
| Silently withhold without blocking | ✗ | ✗ | ✓ |
| Works on Shopify Basic | — | some | ✓ |
| Setup time | — | hours | 5 minutes |

### Social proof

Placeholder for 3 merchant logos + one quoted testimonial. Post-beta.

### FAQ teaser (5 questions)

Full FAQ on `/pricing` (one fewer page to navigate).

### Final install CTA

```
┌──────────────────────────────────────────────────────────────────────┐
│   Ready in 5 minutes. Free for your first 100 redemptions/month.     │
│                      [ Install on Shopify → ]                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Pricing (`/pricing`)

### Tiers

```
┌─ Free ──────────────┐  ┌─ Starter ──────────┐  ┌─ Growth ───────────┐
│                     │  │                     │  │                     │
│   $0 /month         │  │   $19 /month        │  │   $49 /month        │
│                     │  │                     │  │                     │
│   100 redemptions   │  │   1,000 redemptions │  │   10,000 redemptions│
│   per month         │  │   per month         │  │   per month         │
│                     │  │                     │  │                     │
│   All features      │  │   All features      │  │   All features      │
│                     │  │                     │  │                     │
│   [ Install free ]  │  │   [ Install ]       │  │   [ Install ]       │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

Billed via Shopify Billing API. All tiers have identical features — the only difference is the monthly volume cap. Above-cap redemptions aren't blocked; they're just not scored (fail-open) until the next billing cycle or an upgrade.

Enterprise tier: "Contact us" for > 10k/month.

### FAQ

Expandable accordions, 8 items. Direct answers, no fluff.

1. **What counts as a "redemption"?** — Every paid order that used one of your protected codes.
2. **Do you work with Shopify Plus?** — Yes, identically. Plus-specific features (checkout customization) aren't our focus.
3. **Will this block legitimate customers?** — Rarely. We score on multiple signals, not just one, to minimize false positives. Legitimate buyers with no prior redemption are never affected.
4. **Do you see my customers' PII?** — We hash phone/email/address for matching and store raw encrypted copies only for compliance purposes. Per-shop salt prevents cross-shop correlation.
5. **What if I want to undo protection?** — Delete the protected offer; we restore any discounts we replaced. No lock-in.
6. **What if the same family orders from the same address?** — First order goes through normally. A second order using the same code would be blocked or silently skipped. They can still check out at full price.
7. **How do I test it without going live?** — Install on a dev store, create a test protected offer, redeem once, try to redeem again.
8. **What data do you store?** — Hashed identity signals (for matching), encrypted raw values (for compliance deletion), order references. See our [privacy page](/privacy).

---

## 6. Privacy page (`/privacy`)

Required by Shopify's app review. Sections:

1. **Who we are** — app name, publisher, support email.
2. **What data we collect** — from Shopify: order email, phone, shipping address, billing address, IP, customer ID (if logged in), discount codes used. From merchants: store domain, OAuth scopes.
3. **Why we collect it** — anti-abuse scoring. Bullet-listed exact uses.
4. **How long we keep it** — default 2 years from redemption date, or until merchant deletes their offer, or until merchant uninstalls (48h grace, then purge).
5. **Subprocessors** — Postgres host, email provider, error monitoring. Named with links to their policies.
6. **Rights of end customers** — data_request and erasure handled via the merchant, who relays via Shopify's compliance webhooks.
7. **Security controls** — encryption at rest, per-shop salts, access controls, audit logging. Details on `/security`.
8. **Contact for privacy concerns** — dedicated email (`privacy@promoguard.app`).
9. **Last updated** — date.

---

## 7. Security page (`/security`)

Required for approval for Level 2 protected customer data access. Brief, structured:

- **Encryption** — TLS 1.3 in transit. AES-256-GCM at rest for all PII columns.
- **Key management** — per-shop DEK wrapped by app KEK in a managed KMS.
- **Access control** — team SSO (Google Workspace), MFA required, read-only production DB by default.
- **Audit logging** — every team access to merchant data is logged with the team member, timestamp, and reason.
- **Infrastructure** — hosted on [region]. Backups encrypted. Deletion policy matches retention.
- **Incident response** — 72-hour breach notification commitment.
- **Compliance** — GDPR subprocessor agreements, Shopify compliance webhooks wired end-to-end.
- **Reach out** — `security@promoguard.app` for security researchers.

---

## 8. Install route (`/install`)

Handles `?shop=foo.myshopify.com` query param from the Shopify App Store or direct merchant link.

Logic:
1. If `shop` param matches `/^[a-z0-9][a-z0-9-]{0,49}\.myshopify\.com$/`, redirect to `/auth?shop=<shop>`.
2. Otherwise show a form: "Enter your shop domain" → validate → redirect.

This is the handoff to OAuth. Nothing persists from the landing page into the app — the app handles install from OAuth forward.

---

## 9. Analytics (privacy-respecting)

Use a minimal analytics setup: server-side page views, no cookies, no client-side tracking on public pages. Enough to answer:
- How many people visit `/` per day?
- What's the conversion rate to Install?
- Which pages do visitors bounce from?

Self-hosted Plausible or equivalent. No Google Analytics, no Facebook Pixel — customers hate them on anti-abuse apps.

---

## 10. Open Graph / SEO

- `<title>` on `/`: "Promo Guard — Stop welcome-offer abuse on Shopify"
- `<meta description>`: "Catch repeat redemptions of your welcome discount even when abusers use a new email. 5-minute install. Any Shopify plan."
- OG image: the problem-diagram (the three email variants with same phone) — more attention-grabbing than a generic hero.
- JSON-LD: `SoftwareApplication` schema with ratings placeholder (populate post-launch with real App Store reviews).
- Canonical URLs on every page.
- Sitemap at `/sitemap.xml`.
- `robots.txt` allows all.

---

## 11. Performance

- Static HTML for `/`, `/pricing`, `/privacy`, `/security` — served at the edge.
- Target: Largest Contentful Paint under 1.2 s on mobile.
- No JS on landing pages except the install form's client-side validation (< 5 KB).
- Images: WebP with fallback, lazy-loaded below the fold.

---

## 12. Copy voice

- **Direct.** "Stop welcome-offer abuse." Not "Optimize your promotional integrity."
- **Specific.** Names and numbers where possible: "khoi.nguyen ↔ testerkhoi@gmail.com."
- **Honest about limits.** FAQ #3 explicitly says "Rarely" for false positives. Merchants respect this more than "Never!"
- **No Shopify jargon** on the landing page. "Your welcome code" not "Your discount with `appliesOncePerCustomer`."

---

## 13. Not on the landing page

| Not here | Why |
|---|---|
| Live demo | The setup is so short, users should just install on a dev store |
| Blog | Later. Not a day-one differentiator. |
| Comparison-to-competitor callouts | We link generically ("typical fraud app"); named comparisons invite retaliatory content |
| Free trial countdown timer | No pressure tactics |
| Exit-intent popup | See above |
| Chat widget | We're tiny; email support is faster than a half-staffed chat |

---

## 14. File layout (inside the Remix app)

```
app/
  routes/
    _public._index.tsx             ← /
    _public.pricing.tsx
    _public.privacy.tsx
    _public.security.tsx
    _public.docs.tsx               ← redirect
    _public.install.tsx
    _public.tsx                    ← layout wrapper (header, footer, no shop auth)
  components/
    public/
      hero.tsx
      problem-block.tsx
      three-step.tsx
      comparison-table.tsx
      pricing-tier.tsx
      faq-accordion.tsx
      footer.tsx
```

`_public` prefix keeps public routes outside the embedded-Shopify layout.

---

## 15. Launch checklist

Before promoting:
- [ ] App listed and approved on Shopify App Store
- [ ] Privacy policy live and linked from the listing
- [ ] Security page live
- [ ] Level 2 protected customer data access granted by Shopify
- [ ] At least 3 beta merchants with consent for testimonials (name + logo or anonymous)
- [ ] Install flow tested on a fresh development store
- [ ] Uninstall flow tested (data retention + compliance webhooks fire correctly)
- [ ] Billing tested with all three tiers (free → starter upgrade → growth upgrade)
- [ ] Support email monitored
- [ ] First-week metrics dashboard (in platform admin — see `platform-admin-spec.md`)
