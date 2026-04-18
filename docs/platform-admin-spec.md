# Promo Guard — Platform Admin Spec

The internal admin dashboard our team uses to run the product. Separate from the merchant-facing admin UI that lives inside Shopify.

Goal: **one place to monitor every shop's health, debug issues, and handle support without SSH.**

---

## 1. Scope

- Serves the Promo Guard team (us), not merchants.
- Read-heavy: we mostly look at data, occasionally take support actions.
- Not customer-facing — internal tool, zero UX polish expected.
- Must be secure — access to PII across all shops.

**Not in scope**: billing administration beyond viewing (Shopify handles billing), team user management UI (we manage via env var for MVP).

---

## 2. Access control

### Auth strategy for MVP

- **Email allowlist** via environment variable `PLATFORM_ADMIN_ALLOWED_EMAILS` (comma-separated).
- Login via **magic link sent to the allowed email** (no passwords).
- Session lasts 8 hours, then re-login required.
- Every session logs `who / when / from-IP` to `AdminSession` table.

### Production hardening (post-MVP)

- Migrate to Google Workspace SSO via OAuth with domain restriction.
- Add per-team-member roles: `viewer`, `support`, `engineer`, `admin`.
- Require MFA via Google Workspace's enforcement.
- IP allowlist (office + VPN) as an optional second gate.

### Audit log

Every admin action writes to `AdminAuditLog`:

```
admin_user_email, action, target_type, target_id, metadata_json, ip, user_agent, created_at
```

Actions include: viewing a shop's PII, impersonating a shop, dismissing a flagged order on behalf of a merchant, running a manual shard rebuild, exporting customer data, deleting a shop.

---

## 3. URL structure

All routes under `/admin/*` on the same Remix app.

```
/admin                              → dashboard
/admin/login                        magic-link login
/admin/shops                        list of all installed shops
/admin/shops/:id                    shop detail + drill-downs
/admin/shops/:id/offers             offers for this shop
/admin/shops/:id/redemptions        recent redemptions (decrypted, audited)
/admin/shops/:id/flagged            flagged orders
/admin/shops/:id/jobs               jobs tied to this shop
/admin/shops/:id/webhooks           recent webhook events
/admin/shops/:id/impersonate        start a read-only session as this shop (for support)
/admin/jobs                         global job queue status
/admin/dead-letters                 failed jobs needing attention
/admin/compliance                   GDPR queue (customers/data_request, redact, shop/redact)
/admin/metrics                      aggregate metrics (installs, redemptions, flags, false-positive rate)
/admin/audit                        search the AdminAuditLog
/admin/feature-flags                toggle features per-shop or globally
```

Middleware: every `/admin/*` route checks the session. No session → redirect to `/admin/login`.

---

## 4. `/admin` — dashboard

Single page with the key ops numbers.

```
┌─ Promo Guard — Platform ────────────────────────── Logged in: kp@… ──┐
│                                                                       │
│   ── Last 24 hours ────────────────────────────────────────────────   │
│   Installs:       12                                                  │
│   Uninstalls:      3                                                  │
│   Paid redemptions processed:    14,823                               │
│   Blocked at checkout:              482                               │
│   Post-order flagged:                89                               │
│   Webhook failures (after retries):   2                               │
│   Dead-letter jobs:                   1                               │
│                                                                       │
│   ── Health ────────────────────────────────────────────────────────   │
│   Job queue depth:    0 pending     47 processed last hour            │
│   Webhook p95 latency:    280 ms                                      │
│   Function input errors (last 24h):    0                              │
│                                                                       │
│   ── Compliance queue ─────────────────────────────────────────────   │
│   Pending data_request:   0                                           │
│   Pending customer redact:  2 (within SLA)                            │
│   Pending shop redact:      0                                         │
│                                                                       │
│   [ Jump to dead-letters ]    [ Jump to compliance ]                  │
└───────────────────────────────────────────────────────────────────────┘
```

All numbers are live (computed on load, 30-second client-side poll). Clicking any number drills down.

---

## 5. `/admin/shops` — all shops

Searchable, sortable list.

```
┌─ Shops ────────────── Search: [              ]   Filter: [ All ▾ ] ──┐
│                                                                       │
│   shop                          plan      installed      offers       │
│   ──────────────────────────────────────────────────────────────────  │
│   foo.myshopify.com             Shopify   Apr 02 2026   2             │
│   bar-cosmetics.myshopify.com   Advanced  Apr 15 2026   1             │
│   babaco.myshopify.com          Basic     Apr 16 2026   1             │
│                                                                       │
│   [ 1 ]  2  3 … 12   Showing 25 of 287                                │
└───────────────────────────────────────────────────────────────────────┘
```

Filters: `All`, `Active`, `Uninstalled < 48h`, `Uninstalled + redacted`. Sort by install date, uninstall date, redemption count, flag count.

---

## 6. `/admin/shops/:id` — shop detail

```
┌─ bar-cosmetics.myshopify.com ────────────────────────────────────────┐
│                                                                       │
│   Plan:            Shopify Advanced                                   │
│   Installed:       Apr 15 2026                                        │
│   Status:          Active                                             │
│   Country code:    +1 (US)                                            │
│   Protected data:  Level 2 approved                                   │
│                                                                       │
│   ── Overview ──────────────────────────────────────────────────────  │
│   Protected offers:  1 (Welcome program)                              │
│   Redemptions (30d): 1,204                                            │
│   Blocked (30d):        67                                            │
│   Flagged (30d):        42                                            │
│   Webhook failures (7d):  0                                           │
│                                                                       │
│   ── Sections ──────────────────────────────────────────────────────  │
│   [ Offers ]  [ Redemptions ]  [ Flagged ]  [ Jobs ]  [ Webhooks ]   │
│   [ Impersonate (read-only) ]                                         │
│                                                                       │
│   ── Danger zone ───────────────────────────────────────────────────  │
│   [ Force shard rebuild ]  [ Trigger compliance purge ]              │
└───────────────────────────────────────────────────────────────────────┘
```

Side panel (collapsed by default) shows shop's full OAuth scope list, webhook subscription status, and the app-owned metafield inventory.

---

## 7. `/admin/shops/:id/redemptions` — decrypted view (audited)

Viewing this page writes to `AdminAuditLog` with action `view_pii`. The page warns the viewer before rendering:

```
┌─ Viewing customer PII ───────────────────────────────────────────────┐
│                                                                       │
│   You're about to see decrypted email, phone, and address data for   │
│   bar-cosmetics.myshopify.com.                                        │
│                                                                       │
│   Reason (logged):                                                    │
│   [                                                                 ] │
│                                                                       │
│                               [ Cancel ]   [ View ]                   │
└───────────────────────────────────────────────────────────────────────┘
```

Reason is required, free-text, stored in the audit log. Common reasons: "support ticket #123", "debugging false positive report", "GDPR data_request export".

Once confirmed, the table appears:

```
┌─ Redemptions · bar-cosmetics.myshopify.com ────────────────────────────┐
│                                                                         │
│   order     code        email                   phone         created  │
│   ─────────────────────────────────────────────────────────────────── │
│   #1042    WELCOME10   jane@example.com         +1555...     Apr 17   │
│   #1041    WELCOME10   mark@example.com         +1555...     Apr 17   │
│   ...                                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

Columns truncate by default, click to reveal.

---

## 8. `/admin/shops/:id/impersonate` — support mode

Opens a new tab rendering the merchant's admin UI (`/app/*` routes) in **read-only mode**, as if we were the merchant.

Implementation:
- Server-side issues a short-lived (15-minute) impersonation session tied to the shop.
- Every page in read-only mode shows a red banner: "Impersonating bar-cosmetics. Read-only. Logged."
- All mutating actions (create offer, dismiss flag, etc.) are disabled.
- Every page load writes an `AdminAuditLog` entry.

Useful for debugging merchant-reported issues without asking them to screenshot everything.

---

## 9. `/admin/jobs` — job queue visibility

```
┌─ Jobs ────────────────── Filter: [ All ▾ ]  [ Failed ▾ ]  [ Type ▾ ] ┐
│                                                                       │
│   id           type                shop                 status   age │
│   ────────────────────────────────────────────────────────────────── │
│   j-8f2a1c3   shard_append       bar-cosmetics...     running   2s  │
│   j-8f2a1c2   handle-orders-paid foo.myshopify.com    pending  25s  │
│   j-8f2a1bf   compliance-redact  gone.myshopify.com   done      3m  │
│   j-8f2a1be   shard_rebuild      babaco...            failed   12m  │
│                                                                       │
│   Depth: 1 pending · 1 running · 0 failed needing retry · 1 dead     │
└───────────────────────────────────────────────────────────────────────┘
```

Clicking a job opens its detail: payload, attempts, error messages, per-attempt timing. Actions: `Retry now`, `Mark dead`.

---

## 10. `/admin/dead-letters` — failed jobs needing attention

Jobs with `attempts >= 5` and `alertSent = true`. Priority list for engineers.

```
┌─ Dead-letter jobs ───────────────────────────────────────────────────┐
│                                                                       │
│   j-8f2a1be   shard_rebuild    babaco...     12m ago                 │
│   Error: Cannot read properties of undefined (reading 'value')       │
│          at buildShard (app/jobs/shard-rebuild.ts:45)                │
│                                                                       │
│   [ View payload ]  [ Retry once more ]  [ Archive ]                 │
└───────────────────────────────────────────────────────────────────────┘
```

Archiving a dead letter logs the decision to the audit log. Retrying resets `attempts` to 0 and re-queues.

---

## 11. `/admin/compliance` — GDPR queue

Shows every `ComplianceRequest` row, grouped by topic and status.

```
┌─ Compliance requests ────────────────────────────────────────────────┐
│                                                                       │
│   ── customers/data_request ──                                        │
│   • bar-cosmetics.myshopify.com · customer 4827 · pending · 1d old    │
│     [ Export and email merchant ]                                     │
│                                                                       │
│   ── customers/redact ──                                              │
│   • bar-cosmetics.myshopify.com · customer 1203 · completed · 3d ago │
│   • foo.myshopify.com · customer 9121 · pending · 4d old   (SLA: 7d) │
│     [ Run redaction now ]                                             │
│                                                                       │
│   ── shop/redact ──                                                   │
│   (none pending)                                                      │
└───────────────────────────────────────────────────────────────────────┘
```

Each entry has manual controls to re-run the associated job. Critical for ensuring SLA compliance if a worker failed silently.

---

## 12. `/admin/metrics` — aggregate metrics

Tracks cross-shop trends. Not per-shop.

- Installs over time (line chart, daily)
- Uninstalls over time
- Retention cohorts (install date → active-at-week-N)
- Redemptions processed per hour (line chart)
- Block-rate distribution (histogram: "% of redemptions blocked per shop")
- Flag-rate distribution
- False-positive rate (merchant-dismissed flags / total flagged)
- Revenue by tier (Free / Starter / Growth counts)
- P50/P95/P99 webhook processing latency

Useful for product decisions. "Our median shop has 3% flag rate — is that too high?"

Build with a charting lib (Recharts or Chart.js). No dashboards-as-a-service dependencies for MVP.

---

## 13. `/admin/feature-flags` — controlled rollouts

Simple key-value table:

```
flag_name                 default    shop-overrides
────────────────────────────────────────────────────────
minhash_v2                off        [+]
use_risk_assessment_v2    on         bar-cosmetics.myshopify.com: off
enable_ip_prefix_v48      off        foo.myshopify.com: on
```

Backed by a `FeatureFlag` table. Code reads flags via `isEnabled(shopId, flagName)`. Changes apply within 60 seconds (cache TTL).

Used for:
- Gradual rollout of new hashing variants
- Kill-switching broken code paths per shop
- A/B testing thresholds

---

## 14. `/admin/audit` — access log

Filterable table of every `AdminAuditLog` entry.

```
time           admin            action           target                   reason
────────────────────────────────────────────────────────────────────────────────
10:42:11 UTC   kp@...           view_pii         bar-cosmetics/1042       support ticket #93
10:35:04 UTC   alice@...        impersonate      foo.myshopify.com        debugging flag false positive
09:12:33 UTC   kp@...           delete_shop      gone.myshopify.com       GDPR shop/redact
```

Filter by admin email, action, date range, target. Export CSV for external audit.

Logs cannot be deleted via the UI. Retained for 3 years.

---

## 15. Support workflows

### A merchant reports "my legitimate customer got blocked"

1. Ask merchant for order ID or customer email.
2. Go to `/admin/shops/:id`, find the shop.
3. `/admin/shops/:id/flagged` — search for the order.
4. Click the flagged order → see the exact signals that matched.
5. Cross-check against the prior redemption it matched against.
6. Decide: genuine false positive (add to a watch-list for thresholds), or legitimate block (explain to merchant).
7. If false positive: dismiss the flag in the merchant's app (via impersonate if needed).

### A shop's redemption count looks anomalous

1. `/admin/metrics` → spot outlier.
2. `/admin/shops/:id` → drill in.
3. `/admin/shops/:id/jobs` → check for stuck/failed jobs.
4. If shards haven't been rebuilding: `[ Force shard rebuild ]` on shop detail.

### A merchant says "I uninstalled, please delete my data"

- They don't have to ask us — uninstall + 48 hours = automatic `shop/redact`.
- If they want it faster: manually trigger `compliance_shop_redact` via `/admin/shops/:id` danger zone.

---

## 16. File layout

```
app/
  routes/
    admin._index.tsx
    admin.login.tsx
    admin.shops._index.tsx
    admin.shops.$id._index.tsx
    admin.shops.$id.offers.tsx
    admin.shops.$id.redemptions.tsx
    admin.shops.$id.flagged.tsx
    admin.shops.$id.jobs.tsx
    admin.shops.$id.webhooks.tsx
    admin.shops.$id.impersonate.tsx
    admin.jobs.tsx
    admin.dead-letters.tsx
    admin.compliance.tsx
    admin.metrics.tsx
    admin.feature-flags.tsx
    admin.audit.tsx
    admin.tsx                            ← layout + auth gate
  lib/
    admin-auth.server.ts                 ← magic-link + session
    admin-audit.server.ts                ← audit log writer
    admin-impersonation.server.ts        ← impersonation session issuance
  components/
    admin/
      dashboard-card.tsx
      shop-list-row.tsx
      pii-reveal-warning.tsx
      job-status-row.tsx
      flag-row.tsx
      chart-line.tsx
      chart-histogram.tsx
```

---

## 17. Database additions (on top of the main schema)

```prisma
model AdminUser {
  id           String   @id @default(cuid())
  email        String   @unique
  role         String   @default("viewer")        // "viewer" | "support" | "engineer" | "admin"
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())
  lastLoginAt  DateTime?
  sessions     AdminSession[]
  auditLogs    AdminAuditLog[]
}

model AdminSession {
  id         String   @id @default(cuid())
  adminId    String
  token      String   @unique
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime @default(now())
  expiresAt  DateTime
  revokedAt  DateTime?
  admin      AdminUser @relation(fields: [adminId], references: [id], onDelete: Cascade)
}

model AdminAuditLog {
  id          String   @id @default(cuid())
  adminId     String
  adminEmail  String                                // denormalized for long-term clarity
  action      String                                // e.g., "view_pii", "impersonate", "delete_shop"
  targetType  String?
  targetId    String?
  metadata    String?                               // JSON
  reason      String?
  ipAddress   String?
  userAgent   String?
  createdAt   DateTime @default(now())
  admin       AdminUser @relation(fields: [adminId], references: [id], onDelete: Cascade)
  @@index([createdAt])
  @@index([adminId, createdAt])
  @@index([targetType, targetId])
}

model FeatureFlag {
  id           String   @id @default(cuid())
  name         String   @unique
  defaultValue Boolean  @default(false)
  description  String?
  overrides    FeatureFlagOverride[]
  updatedAt    DateTime @updatedAt
}

model FeatureFlagOverride {
  id           String   @id @default(cuid())
  flagId       String
  shopId       String?                             // null means global override
  value        Boolean
  createdAt    DateTime @default(now())
  flag         FeatureFlag @relation(fields: [flagId], references: [id], onDelete: Cascade)
  @@unique([flagId, shopId])
}
```

---

## 18. Security considerations

- **CSRF protection** on all POST/PUT/DELETE routes (Remix built-in + our tokens).
- **Rate limiting** on `/admin/login` to prevent magic-link spam (5 requests per email per hour).
- **Session revocation** on password-like events (if we ever add passwords): logout from all sessions.
- **Read-only DB role** for most admin routes. Write routes explicitly opt into the write role.
- **Never log PII** to server logs from admin actions. Audit log is structured; don't spray into console.log.
- **IP pinning**: admin sessions tied to the IP they were created from. Change of IP = re-login.

---

## 19. Performance / scale assumptions

- Scale target for MVP: 1,000 shops, 10 team members.
- All admin pages server-render; client-side JS only for charts and the magic-link form.
- Database: same Postgres as the main app. Admin reads don't contend with merchant paths thanks to indexes on `Shop.shopDomain`, `Job.status`, `FlaggedOrder.createdAt`.
- When we exceed 10k shops: add a read replica and point `/admin/metrics` at it.

---

## 20. Not building for MVP

| Not here | Why |
|---|---|
| Merchant-aware pricing overrides | Use Shopify Billing for all money decisions |
| Slack integration for alerts | Email to on-call via existing paging — one less dependency |
| Customer support ticket system | Use email (help@) + link to the relevant shop in admin |
| Analytics dashboards beyond /metrics | Not our strength; use Grafana + Postgres read replica later |
| Machine-learning model to auto-tune weights | Way post-MVP. Hand-tuned constants + per-shop feature flags are enough |

---

## 21. Launch-day checklist

- [ ] `PLATFORM_ADMIN_ALLOWED_EMAILS` set in production env
- [ ] Magic-link sending works end-to-end (test from a fresh email)
- [ ] `AdminAuditLog` writes are flowing for every sensitive action
- [ ] Impersonation read-only banner visibly renders
- [ ] Feature flag `minhash_v2` starts `off` — rollout plan written separately
- [ ] Grafana alert on `dead-letters count > 0 for > 15 minutes`
- [ ] Grafana alert on `compliance pending > 5 days`
- [ ] Grafana alert on `webhook p95 latency > 1s`
- [ ] Access to `/admin/*` verified blocked for unauthenticated visitors
