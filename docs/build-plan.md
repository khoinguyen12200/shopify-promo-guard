# Promo Guard — Build Plan

Ordered atomic tasks. Each task is small enough for one AI session. See `docs/build-orchestration-spec.md` for the system design behind this doc.

**Conventions**
- Status: `☐ pending`, `◐ in progress`, `☑ done`
- "Specs" lists the doc sections to read BEFORE starting the task. Don't load others.
- "Depends" lists prior task IDs that must be done first.
- "Acceptance" is the go/no-go — commit only if every bullet is true.
- Commit message format: `Txx: <task title>` — body notes any spec deviations.

---

## Phase 0 — Foundation

### ☑ T01. docker-compose.yml for local Postgres
**Specs:** `docs/build-orchestration-spec.md §3` · `CLAUDE.md § Infrastructure`
**Depends:** none
**Files:**
- `docker-compose.yml` (create) — Postgres 16, port 5434, user/pass `promo/promo`, db `promo_guard`, named volume
- `.gitignore` (edit) — ensure `docker data/` isn't committed
**Acceptance:**
- `make db-up` succeeds and Postgres is reachable at `localhost:5434`
- `make db-psql` opens a psql shell

---

### ☐ T02. Prisma schema from `database-design.md`
**Specs:** `docs/database-design.md §entire`
**Depends:** T01
**Files:**
- `prisma/schema.prisma` (rewrite) — all 11 core models + Session
- `prisma/migrations/<ts>_init_promo_guard/` (generated)
**Acceptance:**
- `make db-migrate` succeeds on a fresh DB
- `npx prisma validate` passes
- Every model and index from the spec exists

---

### ☐ T03. `.env` + env loading
**Specs:** `CLAUDE.md § Infrastructure`
**Depends:** T01
**Files:**
- `.env.example` (create) — `DATABASE_URL`, `DIRECT_DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `APP_KEK_HEX`, `SESSION_SECRET`, `PLATFORM_ADMIN_ALLOWED_EMAILS`, `SHOPIFY_APP_URL`
- `.env` (create from example, untracked)
- `app/lib/env.server.ts` (create) — zod-validated env reader
**Acceptance:**
- App fails to start with a clear error if any required env is missing
- `app/lib/env.server.ts` is the single reader — no direct `process.env` elsewhere

---

### ☐ T04. Per-shop salt + encryption key
**Specs:** `docs/database-design.md § Encryption approach` · `docs/normalization-spec.md §7`
**Depends:** T02, T03
**Files:**
- `app/lib/crypto.server.ts` — AES-256-GCM encrypt/decrypt, KEK-wrapped DEK
- `app/lib/shop.server.ts` — `ensureShop(shopDomain, accessToken)` generates salt + DEK on first install
- `scripts/seed-dev.ts` — inserts a fake Shop row for dev
**Acceptance:**
- Fresh install creates a Shop with 32-byte hex salt and wrapped DEK
- Encrypt → decrypt round-trips correctly
- Unit tests cover: key rotation, tampered ciphertext rejected, missing KEK errors clearly

---

## Phase 1 — Shared hash/normalize/score contract

### ☐ T05. `shared-rust/` skeleton
**Specs:** `docs/build-orchestration-spec.md §5`
**Depends:** none
**Files:**
- `shared-rust/Cargo.toml`
- `shared-rust/src/lib.rs` — module declarations
- `shared-rust/src/constants.rs` — salt format, version markers
**Acceptance:**
- `cd shared-rust && cargo build` succeeds
- The validator and discount extensions can depend on it via path (verified by a minimal use statement — not integrated yet)

---

### ☐ T06. FNV-1a + salted hash — Rust + Node + fixture
**Specs:** `docs/normalization-spec.md §5, §7, §9`
**Depends:** T05
**Files:**
- `shared-rust/src/hash.rs` — `fnv1a_32`, `hash_for_lookup`
- `app/lib/hash.server.ts` — port
- `docs/test-fixtures/hash-vectors.json` — seed with §5 canonical FNV values
- `shared-rust/tests/hash_vectors.rs` — reads fixture, asserts
- `app/lib/hash.test.ts` — reads fixture, asserts
**Acceptance:**
- Canonical FNV values verify (`"a"` → `0xe40c292c`, `"hello"` → `0x4f9f2cab`)
- `make test-fixture-parity` passes

---

### ☐ T07. Email normalization + trigrams
**Specs:** `docs/normalization-spec.md §1, §4`
**Depends:** T06
**Files:**
- `shared-rust/src/normalize/email.rs`
- `app/lib/normalize/email.server.ts`
- Fixture additions: all §1 test vectors
**Acceptance:**
- Every test vector in §1 and §4 passes both implementations
- `khoinguyen@gmail.com` canonical is stable across Node/Rust

---

### ☐ T08. Phone E.164 normalization
**Specs:** `docs/normalization-spec.md §2`
**Depends:** T06
**Files:**
- `shared-rust/src/normalize/phone.rs`
- `app/lib/normalize/phone.server.ts`
- Fixture additions: all §2 test vectors
**Acceptance:**
- §2 test vectors pass in both implementations
- Invalid input returns `null`/`None` cleanly

---

### ☐ T09. Address normalization + house key
**Specs:** `docs/normalization-spec.md §3, §4`
**Depends:** T06
**Files:**
- `shared-rust/src/normalize/address.rs`
- `app/lib/normalize/address.server.ts`
- Fixture additions: all §3 test vectors, trigrams for §4 address cases
**Acceptance:**
- §3 test vectors pass, including the Vietnamese diacritic case
- `full_key` and `house_key` computed identically

---

### ☐ T10. MinHash bottom-K + Jaccard
**Specs:** `docs/normalization-spec.md §6`
**Depends:** T07, T09
**Files:**
- `shared-rust/src/hash/minhash.rs`
- `app/lib/hash/minhash.server.ts`
- Fixture additions: `email_minhash` and `jaccard` sections
**Acceptance:**
- A fixed input produces the same `[u32; 4]` sketch in Rust and TS
- `jaccard_count` returns integers in `0..=4` as documented

---

### ☐ T11. Scoring constants + weights
**Specs:** `docs/scoring-spec.md §3`
**Depends:** T06
**Files:**
- `shared-rust/src/scoring/constants.rs`
- `app/lib/scoring/constants.server.ts`
- `scripts/generate-constants.ts` — generates both files from one JSON source
**Acceptance:**
- Both files expose `THRESHOLD_MEDIUM = 4`, `THRESHOLD_HIGH = 10`, and the weight table from §3
- Regenerating from the JSON source produces identical diffs on both targets

---

### ☐ T12. Post-order scoring (Node)
**Specs:** `docs/scoring-spec.md §5.2, §10`
**Depends:** T04, T07–T11
**Files:**
- `app/lib/scoring/post-order.server.ts`
- `app/lib/scoring/post-order.test.ts` — covers every worked example in §9
**Acceptance:**
- §9 Case 1–4 produce the documented scores
- Per-record max semantics applied correctly

---

### ☐ T13. Checkout scoring (shared-rust, not yet in a Function)
**Specs:** `docs/scoring-spec.md §5.1, §10`
**Depends:** T07–T11
**Files:**
- `shared-rust/src/scoring/checkout.rs`
- `shared-rust/tests/scoring_checkout.rs` — unit tests
**Acceptance:**
- Same §9 scenarios produce the same scores as T12's Node implementation
- `cargo test` passes

---

## Phase 2 — Webhooks + job queue

### ☐ T14. Webhook auth + dedup middleware
**Specs:** `docs/webhook-spec.md §3, §4`
**Depends:** T02, T03
**Files:**
- `app/lib/webhook-auth.server.ts` — wraps `authenticate.webhook`, handles `WebhookEvent` dedup
- `app/routes/webhooks._test.tsx` — dev-only HMAC sanity route
**Acceptance:**
- Invalid HMAC returns 401
- Duplicate `webhookGid` returns 200 silently (dedup test)
- Unknown shop returns 200 (no retry)

---

### ☐ T15. Job queue (table-backed) + worker process
**Specs:** `docs/webhook-spec.md §8, §12`
**Depends:** T02
**Files:**
- `app/lib/jobs.server.ts` — `enqueueJob`, retry semantics
- `app/workers/worker.ts` — polling runner
- `package.json` (add `worker` script, `tsx` dep)
- `app/lib/jobs.test.ts` — enqueue + claim + retry + dead-letter
**Acceptance:**
- Worker claims pending jobs atomically (FOR UPDATE SKIP LOCKED or equivalent)
- Exponential backoff on retry
- After 5 failures, job is marked dead-letter

---

### ☐ T16. Admin GraphQL helpers
**Specs:** `docs/webhook-spec.md §9` · `docs/function-queries-spec.md § Verified Shopify schema facts`
**Depends:** T04
**Files:**
- `app/lib/admin-graphql.server.ts` — `orderRiskAssessmentCreate`, `tagsAdd`, `metafieldsSet`
- `app/lib/admin-graphql.test.ts` — mock Shopify responses
**Acceptance:**
- Each helper handles 200, 429 (retry with backoff), and userErrors
- Batching works for `metafieldsSet` (5 keys in one call)

---

### ☐ T17. Shard metafield read/write
**Specs:** `docs/webhook-spec.md §5 (shard_append sub-job)` · `docs/function-queries-spec.md §2`
**Depends:** T11, T16
**Files:**
- `app/lib/shards.server.ts` — serialize, append, evict, rebuild
- `app/lib/shards.test.ts`
**Acceptance:**
- Appending an entry over 10 KB triggers eviction of oldest
- Version tag `v: 1` stays correct
- Concurrent appends are serialized per-offer (advisory lock test)

---

### ☐ T18. `orders/paid` webhook + handler
**Specs:** `docs/webhook-spec.md §5`
**Depends:** T12, T14, T15, T16, T17
**Files:**
- `shopify.app.toml` (edit) — subscribe `orders/paid` with `include_fields`
- `app/routes/webhooks.orders.paid.tsx`
- `app/jobs/handle-orders-paid.ts`
- `app/jobs/shard-append.ts`
- `app/jobs/handle-orders-paid.test.ts` — integration-style test via seeded DB
**Acceptance:**
- Order with no matching code → no DB writes
- Order matching code + new buyer → RedemptionRecord inserted, no flag
- Order matching code + prior-match buyer → RedemptionRecord + FlaggedOrder + risk assessment + tag
- Test suite covers all rows in `docs/webhook-spec.md §10 Tests to write`

---

### ☐ T19. `app/uninstalled` handler
**Specs:** `docs/webhook-spec.md §6`
**Depends:** T14
**Files:**
- `shopify.app.toml` (edit) — subscribe `app/uninstalled`
- `app/routes/webhooks.app.uninstalled.tsx`
- `app/jobs/handle-app-uninstalled.ts`
**Acceptance:**
- `Shop.uninstalledAt` is set; Sessions deleted; pending Jobs cancelled
- Reinstall within 48h restores functionality with ledger intact

---

### ☐ T20. `customers/data_request` handler
**Specs:** `docs/webhook-spec.md §7`
**Depends:** T04, T14, T15
**Files:**
- `shopify.app.toml` (edit)
- `app/routes/webhooks.customers.data_request.tsx`
- `app/jobs/compliance-data-export.ts`
**Acceptance:**
- ComplianceRequest row created
- Decrypt + export JSON for a given customerGid
- SLA countdown starts; test verifies completion path

---

### ☐ T21. `customers/redact` handler
**Specs:** `docs/webhook-spec.md §7`
**Depends:** T17, T20
**Files:**
- `shopify.app.toml` (edit)
- `app/routes/webhooks.customers.redact.tsx`
- `app/jobs/compliance-customer-redact.ts`
**Acceptance:**
- RedemptionRecord PII columns nulled
- Shards rebuilt without redacted entries
- Customer tag removed via Admin API

---

### ☐ T22. `shop/redact` handler
**Specs:** `docs/webhook-spec.md §7`
**Depends:** T14, T15
**Files:**
- `shopify.app.toml` (edit)
- `app/routes/webhooks.shop.redact.tsx`
- `app/jobs/compliance-shop-redact.ts`
**Acceptance:**
- Cascade delete removes all shop-owned rows
- ComplianceRequest marked completed
- No orphans in any table

---

## Phase 3 — Shopify Functions (Rust)

### ☐ T23. Scaffold Validation Function extension
**Specs:** `docs/function-queries-spec.md §7, §8`
**Depends:** T13
**Files:**
- `extensions/promo-guard-validator/` (via `shopify app generate extension --template cart_checkout_validation --flavor rust`)
- `extensions/promo-guard-validator/Cargo.toml` — depend on `../../shared-rust`
**Acceptance:**
- `shopify app function build` succeeds on the unmodified template
- `schema.graphql` downloaded via `shopify app function schema --stdout`
- Binary < 256 KB

---

### ☐ T24. Validator input query + nullability audit
**Specs:** `docs/function-queries-spec.md §3, §9`
**Depends:** T23
**Files:**
- `extensions/promo-guard-validator/src/run.graphql` — exact query from §3
- `docs/function-queries-spec.md` (update §9 table with confirmed values)
**Acceptance:**
- Schema contains `cart.discountCodes` — or §9 Plan B/C is chosen and §3 is updated
- All optional-field nullability observed and documented
- `shopify app function typegen` produces Rust types without errors

---

### ☐ T25. Validator run.rs
**Specs:** `docs/function-queries-spec.md §3` · `docs/scoring-spec.md §5.1, §10`
**Depends:** T13, T24
**Files:**
- `extensions/promo-guard-validator/src/run.rs`
- `extensions/promo-guard-validator/src/main.rs` — wires `#[typegen(...)]`
- `extensions/promo-guard-validator/tests/` — unit tests with seeded shards
**Acceptance:**
- Empty shards → `operations: []` (no errors)
- Phone match in shard → `ValidationAddOperation` with one error
- `shopify app function run` smoke test passes with a sample input

---

### ☐ T26. Scaffold Discount Function extension
**Specs:** `docs/function-queries-spec.md §4, §7, §8`
**Depends:** T13
**Files:**
- `extensions/promo-guard-discount/` (via `shopify app generate extension --template discount --flavor rust`)
- `extensions/promo-guard-discount/Cargo.toml`
**Acceptance:**
- `shopify app function build` succeeds
- Schema downloaded

---

### ☐ T27. Discount input query + run.rs
**Specs:** `docs/function-queries-spec.md §4` · `docs/scoring-spec.md §5.1`
**Depends:** T13, T26
**Files:**
- `extensions/promo-guard-discount/src/cart_lines_discounts_generate_run.graphql`
- `extensions/promo-guard-discount/src/cart_lines_discounts_generate_run.rs`
- `extensions/promo-guard-discount/src/main.rs`
**Acceptance:**
- Score ≥ 10 → `{ operations: [] }`
- Score < 10 → emits OrderDiscountsAdd with the configured percentage/amount
- `cargo test` passes; binary < 256 KB

---

## Phase 4 — Merchant admin UI

### ☐ T28. Remix shell + Shopify OAuth wiring
**Specs:** `docs/admin-ui-spec.md §2, §10`
**Depends:** T03, T04
**Files:**
- `app/routes/app.tsx` — embedded layout
- `app/shopify.server.ts` — Shopify auth config (if template default needs edits)
- `app/routes/app._index.tsx` — redirects
**Acceptance:**
- Fresh install completes OAuth and lands on `/app/onboarding`
- `ensureShop` runs and Shop row is created

---

### ☐ T29. Onboarding page
**Specs:** `docs/admin-ui-spec.md §3`
**Depends:** T28
**Files:**
- `app/routes/app.onboarding.tsx`
- `app/components/setup-checklist.tsx`
**Acceptance:**
- First-run visit renders checklist
- After first offer created, `/app` no longer redirects here

---

### ☐ T30. Offers list page
**Specs:** `docs/admin-ui-spec.md §4`
**Depends:** T28
**Files:**
- `app/routes/app.offers._index.tsx`
- `app/components/offer-list-row.tsx`
- `app/components/activation-nudge.tsx`
**Acceptance:**
- Empty state CTA goes to `/app/offers/new`
- Offer rows show status, codes, metrics
- "Needs activation" nudge renders for block-mode offers without Checkout Rule enabled

---

### ☐ T31. Discount auto-suggest query
**Specs:** `docs/admin-ui-spec.md §5`
**Depends:** T28
**Files:**
- `app/lib/discount-query.server.ts` — query Shopify for candidate welcome discounts
- `app/lib/discount-query.test.ts`
**Acceptance:**
- Returns discounts sorted by `appliesOncePerCustomer` then naming heuristic
- Handles pagination past 50
- Filters out archived + already-protected codes

---

### ☐ T32. Create offer form + manual code entry
**Specs:** `docs/admin-ui-spec.md §5`
**Depends:** T30, T31
**Files:**
- `app/routes/app.offers.new.tsx`
- `app/components/offer-form.tsx`
- `app/components/code-picker.tsx`
**Acceptance:**
- Suggested + Other sections render
- Manual code input with "exists" and "create new" branches
- Validation: at least one code, name required

---

### ☐ T33. Create-new-discount inline subform + Discount Function registration
**Specs:** `docs/admin-ui-spec.md §5 (Case B)` · `docs/system-design.md § Replace-in-place`
**Depends:** T27, T32
**Files:**
- `app/components/create-new-discount.tsx`
- `app/lib/offer-service.server.ts` — includes `discountCodeAppCreate` wrapper
**Acceptance:**
- Non-existent code entry opens subform
- Submit creates app-owned discount via `discountCodeAppCreate` with our Discount Function ID
- The new ProtectedCode is linked to the new discount GID

---

### ☐ T34. Replace-in-place flow
**Specs:** `docs/admin-ui-spec.md §5 (silent-strip with existing code)` · `docs/system-design.md § Replace-in-place`
**Depends:** T33
**Files:**
- `app/components/replace-in-place-modal.tsx`
- `app/lib/offer-service.server.ts` (extend) — deactivate old, create new with same code, store archived GID
**Acceptance:**
- Confirmation modal appears when silent-strip + existing code
- Deactivate-first ordering respected (code uniqueness error never hit)
- `ProtectedCode.replacedDiscountNodeId` populated

---

### ☐ T35. Offer detail page + stats
**Specs:** `docs/admin-ui-spec.md §6`
**Depends:** T30
**Files:**
- `app/routes/app.offers.$id._index.tsx`
- `app/components/stats-card.tsx`
**Acceptance:**
- Shows codes, status, 30-day counts (redemptions, blocked, flagged)
- Recent blocks list shows last 10 FlaggedOrder or score events
- Links to flagged orders page

---

### ☐ T36. Edit offer + pause/resume
**Specs:** `docs/admin-ui-spec.md §6`
**Depends:** T35
**Files:**
- `app/routes/app.offers.$id.edit.tsx`
- Offer-service additions for status transitions
**Acceptance:**
- Edit preserves unchanged fields
- Pause flips `status = "paused"` and Functions skip (verified via integration test)

---

### ☐ T37. Delete offer with restore option
**Specs:** `docs/admin-ui-spec.md §6 (Delete confirmation)`
**Depends:** T34, T35
**Files:**
- `app/routes/app.offers.$id.delete.tsx`
- Offer-service: restore archived discounts path
**Acceptance:**
- Confirmation modal shows restore/delete radio
- Restore reactivates the archived original discount
- Offer row soft-deletes (archivedAt set, not cascading deletion of history)

---

### ☐ T38. Flagged orders page
**Specs:** `docs/admin-ui-spec.md §7`
**Depends:** T18, T35
**Files:**
- `app/routes/app.flagged._index.tsx`
- `app/components/flagged-order-row.tsx`
**Acceptance:**
- Filters: All / Pending / Dismissed / Cancelled
- Dismiss action updates FlaggedOrder.merchantAction
- Cancel deep-links to Shopify admin order page

---

### ☐ T39. Settings page
**Specs:** `docs/admin-ui-spec.md §9`
**Depends:** T28
**Files:**
- `app/routes/app.settings.tsx`
- Salt rotation action + ledger invalidation
**Acceptance:**
- Retention selector persists
- Salt rotation warns + rebuilds shards asynchronously

---

## Phase 5 — Admin UI extension (native order page)

### ☐ T40. Scaffold admin UI extension
**Specs:** `docs/admin-ui-spec.md §8`
**Depends:** T18
**Files:**
- `extensions/promo-guard-order-block/` (via `shopify app generate extension --template admin_ui_extension`)
- `extensions/promo-guard-order-block/shopify.extension.toml` — target `admin.order-details.block.render`
**Acceptance:**
- Scaffolded extension renders a blank card on an order detail page in the dev store

---

### ☐ T41. Order block — fetch + render
**Specs:** `docs/admin-ui-spec.md §8`
**Depends:** T40
**Files:**
- `extensions/promo-guard-order-block/src/OrderBlock.tsx`
- App Remix route exposing flagged data for the extension (auth via extension JWT)
**Acceptance:**
- When order is flagged: block renders facts + actions
- When not flagged: block collapses (zero height)
- Dismiss action updates FlaggedOrder via the app

---

## Phase 6 — Cold-start backfill

### ☐ T42. Cold-start job
**Specs:** `docs/system-design.md § Cold start` · `docs/admin-ui-spec.md (progress indicator)`
**Depends:** T18, T34
**Files:**
- `app/jobs/cold-start.ts`
- Offer-service trigger on offer creation
- UI progress indicator on offer detail page
**Acceptance:**
- Paginates `orders(query: "discount_code:X")` through 250/page
- Inserts RedemptionRecord rows + rebuilds shards
- Completes without hitting Shopify rate limits on a test shop with 1000 orders

---

## Phase 7 — Public pages

### ☐ T43. Public layout + landing page
**Specs:** `docs/landing-page-spec.md §4, §12`
**Depends:** T03
**Files:**
- `app/routes/_public.tsx`
- `app/routes/_public._index.tsx`
- `app/components/public/*` (hero, problem-block, three-step, comparison-table, faq-accordion, footer)
**Acceptance:**
- `/` renders without auth
- Mobile-responsive (verified via Playwright snapshot)
- LCP under 1.2s on simulated 4G

---

### ☐ T44. Pricing, privacy, security, terms, install
**Specs:** `docs/landing-page-spec.md §5, §6, §7, §8`
**Depends:** T43
**Files:**
- `app/routes/_public.pricing.tsx`
- `app/routes/_public.privacy.tsx`
- `app/routes/_public.security.tsx`
- `app/routes/_public.terms.tsx`
- `app/routes/_public.install.tsx`
**Acceptance:**
- `/install?shop=foo.myshopify.com` redirects into OAuth
- Malformed shop param shows the form
- Privacy + security pages render the full content from the spec

---

## Phase 8 — Platform admin

### ☐ T45. Platform-admin Prisma additions + magic-link auth
**Specs:** `docs/platform-admin-spec.md §2, §17`
**Depends:** T02, T03
**Files:**
- `prisma/schema.prisma` (add `AdminUser`, `AdminSession`, `AdminAuditLog`, `FeatureFlag`, `FeatureFlagOverride`)
- New Prisma migration
- `app/lib/admin-auth.server.ts` — magic-link flow
- `app/lib/admin-audit.server.ts`
- `app/routes/admin.tsx` — auth gate layout
- `app/routes/admin.login.tsx`
**Acceptance:**
- Email not in allowlist → login denied
- Allowlisted email receives magic link → 8-hour session
- Every admin page write goes through audit log

---

### ☐ T46. Admin dashboard + shops list
**Specs:** `docs/platform-admin-spec.md §4, §5`
**Depends:** T45
**Files:**
- `app/routes/admin._index.tsx` — dashboard
- `app/routes/admin.shops._index.tsx`
**Acceptance:**
- Dashboard numbers compute correctly on seeded data
- Shop list search + filters work

---

### ☐ T47. Shop detail + decrypted redemption view (audited)
**Specs:** `docs/platform-admin-spec.md §6, §7`
**Depends:** T46
**Files:**
- `app/routes/admin.shops.$id._index.tsx`
- `app/routes/admin.shops.$id.redemptions.tsx`
- `app/components/admin/pii-reveal-warning.tsx`
**Acceptance:**
- PII view requires reason-before-reveal
- Every reveal writes AdminAuditLog `action=view_pii`

---

### ☐ T48. Jobs + dead-letters + compliance + metrics + audit + feature flags
**Specs:** `docs/platform-admin-spec.md §9–§14`
**Depends:** T47
**Files:**
- `app/routes/admin.jobs.tsx`
- `app/routes/admin.dead-letters.tsx`
- `app/routes/admin.compliance.tsx`
- `app/routes/admin.metrics.tsx`
- `app/routes/admin.audit.tsx`
- `app/routes/admin.feature-flags.tsx`
**Acceptance:**
- Each page loads from real DB data (dev seeded)
- Retry/Archive actions on dead-letter queue work
- Feature flags toggle and apply within 60 seconds (cache test)

---

### ☐ T49. Impersonation (read-only)
**Specs:** `docs/platform-admin-spec.md §8`
**Depends:** T47
**Files:**
- `app/routes/admin.shops.$id.impersonate.tsx`
- `app/lib/admin-impersonation.server.ts`
**Acceptance:**
- Opening impersonation gives a read-only session to the merchant UI
- Banner visibly renders on every page
- All mutating actions are disabled
- Session expires after 15 minutes

---

## Phase 9 — Deploy

### ☐ T50. Dockerfiles
**Specs:** `CLAUDE.md § Infrastructure`
**Depends:** T02, T18
**Files:**
- `Dockerfile.dev` (optional, mostly unused — Cloud Run deploys use prod)
- `Dockerfile.prod` — multi-stage: build Remix, copy artifacts, run migrations at start OR leave migrations to cloudbuild
- `.dockerignore`
**Acceptance:**
- `docker build -f Dockerfile.prod .` succeeds locally
- Image runs Remix on port 8080 with `DATABASE_URL` env
- Image size under 500 MB

---

### ☐ T51. `cloudbuild.yaml` (GCP pipeline)
**Specs:** `CLAUDE.md § Infrastructure` · Reference: `~/Projects/shopify-repair-ops/cloudbuild.yaml`
**Depends:** T50
**Files:**
- `cloudbuild.yaml` — build → migrate → push → deploy
- `scripts/deploy.sh` (optional)
**Acceptance:**
- `gcloud builds submit` completes end-to-end on a staging project
- Neon migrations applied before deploy via the image's `prisma migrate deploy`
- Cloud Run revision healthchecks pass

---

### ☐ T52. Production secrets + env
**Specs:** `CLAUDE.md § Infrastructure`
**Depends:** T51
**Files:**
- `scripts/setup-gcp-secrets.sh` — creates Secret Manager entries (idempotent)
- Cloud Run env-var config (via gcloud flags or secret bindings)
**Acceptance:**
- `SHOPIFY_API_SECRET`, `APP_KEK_HEX`, `DATABASE_URL`, `DIRECT_DATABASE_URL`, `SESSION_SECRET` all in Secret Manager
- Cloud Run revision can read them via `--set-secrets`

---

### ☐ T53. Worker deploy (Cloud Run Job or second service)
**Specs:** `docs/webhook-spec.md §12`
**Depends:** T51, T52
**Files:**
- `Dockerfile.worker` (or reuse prod image with different CMD)
- `cloudbuild.yaml` (extend) — deploy worker service
**Acceptance:**
- Worker deployed, polling the production DB, processing a test job
- Failure alerting hooked up (Cloud Monitoring alert policy)

---

### ☐ T54. E2E deploy smoke test
**Specs:** `docs/landing-page-spec.md §15` + `docs/platform-admin-spec.md §21`
**Depends:** T53
**Files:**
- `scripts/e2e-smoke.sh`
**Acceptance:**
- Install on a dev store → OAuth → onboarding → create offer → test order → blocked
- Uninstall → data retained 48h
- Platform admin login + dashboard renders
- Run before any public launch

---

## Phase 10 — Launch readiness

### ☐ T55. Protected customer data application (manual, but tracked here)
**Specs:** `docs/landing-page-spec.md §7` · `docs/system-design.md § Privacy`
**Depends:** T43, T44
**Files:**
- `docs/protected-data-application.md` — fill in with approved copy, submit via Partner Dashboard
**Acceptance:**
- Level 1 + Level 2 granted by Shopify before App Store submission

---

### ☐ T56. App Store listing + review submission
**Specs:** `docs/landing-page-spec.md §15`
**Depends:** T54, T55
**Files:**
- Listing copy, screenshots, icon, demo video (if needed)
**Acceptance:**
- Listing submitted; review round-trip to green

---

## Housekeeping

- When a task completes: mark the checkbox, commit with `Txx: <title>`.
- If a spec changes mid-task: update the spec in the same commit, note in body.
- If a task needs to split: add `Txx.a` / `Txx.b` sub-tasks rather than growing a single task.
- If a new task emerges that doesn't fit: insert at the right phase, renumber downstream tasks only if necessary (prefer append: `T57`, `T58` …).

## Status summary

**Phase 0** (4 tasks): foundation · **Phase 1** (9 tasks): normalize/score · **Phase 2** (9 tasks): webhooks · **Phase 3** (5 tasks): functions · **Phase 4** (12 tasks): merchant UI · **Phase 5** (2 tasks): admin extension · **Phase 6** (1 task): cold start · **Phase 7** (2 tasks): public · **Phase 8** (5 tasks): platform admin · **Phase 9** (5 tasks): deploy · **Phase 10** (2 tasks): launch

Total: **56 tasks**. Current: 0/56 done.
