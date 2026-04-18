# STATE

Resume pointer for the autonomous build coordinator. See `docs/build-run-prompt.md` for usage.

Status markers: `☑` done · `⚠` blocked · `⊖` deferred · `☐` pending

## Current

**Last completed:** Batch 1 (T06, T14, T15, T16, T28, T43)
**Next batch:** T07/T08/T09/T11 in parallel (normalization + scoring constants), then T45 solo (platform admin prisma), then T10/T12/T13 sequentially.
**Run mode:** unattended

## Completed

- ☑ T01 — docker-compose.yml for local Postgres (baseline scaffold bundled)
- ☑ T02 — Prisma schema + init_promo_guard migration (fixed Makefile test-fixture-parity guard)
- ☑ T03 — .env.example + zod env.server.ts (bumped shopify-app-session-storage-prisma to 9, dropped yarn.lock)
- ☑ T04 — crypto.server.ts + shop.server.ts + seed-dev.ts + Vitest wired (17 tests)
- ☑ T05 — shared-rust/ skeleton crate (no deps)
- ☑ T06 — FNV-1a hash + fixture parity + normalize/scoring submodule split (pre-carves T07–T13 files)
- ☑ T14 — webhook-auth.server.ts + dev route (7 tests; P2002 dedup race-safe)
- ☑ T15 — jobs.server.ts + worker.ts (FOR UPDATE SKIP LOCKED, exp backoff via startedAt, 8 tests)
- ☑ T16 — admin-graphql.server.ts (orderRiskAssessmentCreate, tagsAdd, metafieldsSet chunked; 9 tests)
- ☑ T28 — Remix shell + OAuth wiring (ensureShop on load, redirects; removed template s-app-nav + app.additional)
- ☑ T43 — public landing at `/` (6 components, standalone CSS, template _index deleted)

## Blocked

(none)

## Deferred

(none)

## Pre-flight notes

- `.env` present; docker + shopify CLI + wasm32-wasip1 + cargo all available.
- `make verify` green on `main`.
- Unattended overrides active: placeholder secrets ok, Plan C auto for T24, unit-only for T42, scaffold-only T50–T54, T55/T56 human-only BLOCKED.
