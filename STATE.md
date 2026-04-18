# STATE

Resume pointer for the autonomous build coordinator. See `docs/build-run-prompt.md` for usage.

Status markers: `☑` done · `⚠` blocked · `⊖` deferred · `☐` pending

## Current

**Last completed:** T03
**Next task:** T04 (per-shop salt + encryption key)
**Run mode:** unattended

## Completed

- ☑ T01 — docker-compose.yml for local Postgres (baseline scaffold bundled)
- ☑ T02 — Prisma schema + init_promo_guard migration (fixed Makefile test-fixture-parity guard)
- ☑ T03 — .env.example + zod env.server.ts (bumped shopify-app-session-storage-prisma to 9, dropped yarn.lock)

## Blocked

(none yet)

## Deferred

(none yet)

## Pre-flight notes

- `.env` present with all required keys (APP_KEK_HEX, SESSION_SECRET, SHOPIFY_API_KEY/SECRET, SHOPIFY_APP_URL, PLATFORM_ADMIN_ALLOWED_EMAILS, DATABASE_URL, DIRECT_DATABASE_URL).
- Docker running, shopify CLI 3.93.2, wasm32-wasip1 installed, node v24.15.0, cargo 1.88.
- Unattended overrides active: placeholder secrets ok, Plan C auto for T24, unit-only for T42, scaffold-only T50–T54, T55/T56 human-only BLOCKED.
