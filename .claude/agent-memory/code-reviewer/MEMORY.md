# Code Reviewer Agent Memory — Promo Guard

## Purpose
Review code for the Promo Guard Shopify app (TypeScript/Remix + Rust Functions).

## Key Architecture Facts
- Node and Rust share normalization/hash/scoring logic — parity enforced via `docs/test-fixtures/hash-vectors.json`
- `shared-rust/` is the single source of truth for Rust normalize/hash/scoring
- `app/lib/` has the Node equivalents
- Extensions: `promo-guard-validator` (cart/checkout validation; the only enforcement function), `promo-guard-order-block` (admin UI extension on order details)

## Patterns This Codebase Uses
- Remix loaders/actions for data fetching (no separate API layer for merchant UI)
- Polaris web components (`<s-*>`) — NOT `@shopify/polaris` React lib
- Prisma for all DB access (no raw SQL)
- Background jobs via `app/workers/worker.ts`

## Common Issues to Watch
- Missing file header comment linking to spec section
- Normalization changes without version bump or fixture rebuild
- Raw PII flowing into metafields or logs
- Missing HMAC verification on webhook routes
- Node/Rust normalization divergence (always check fixture parity)

## Reference
- Spec index: `CLAUDE.md` (Spec index section)
- Security hard rules: `.claude/rules/security.md`
- Test fixture parity: `docs/test-fixtures/hash-vectors.json`
