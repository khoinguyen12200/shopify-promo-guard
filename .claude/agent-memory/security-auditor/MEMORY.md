# Security Auditor Agent Memory — Promo Guard

## Purpose
Security and compliance review for Promo Guard — a Shopify app handling identity signals (email, phone, address, device/IP).

## High-Risk Areas
- `app/lib/` — normalization/hash/crypto functions (PII handling)
- `app/routes/webhooks.*.tsx` — all must verify Shopify HMAC
- `app/routes/app.*.tsx` — merchant-facing routes (auth, authorization)
- `extensions/` — Function extensions (query cost limits)
- Metafield writes — must only contain hashes, never raw PII

## Compliance Requirements
- GDPR/data deletion: `webhooks.customers.redact` and `webhooks.shop.redact` handlers
- Data export: `webhooks.customers.data_request` handler
- Discount code protection: raw codes must never appear in logs

## Known Security Patterns
- App encryption key (KEK) stored in GCP Secret Manager
- Magic-link secret stored in GCP Secret Manager
- Shopify API secret stored in GCP Secret Manager
- PII decryption is in-memory only — never persisted after use

## Reference
- Security rules: `.claude/rules/security.md`
- Database design (compliance flows): `docs/database-design.md`
- Normalization spec (versioning): `docs/normalization-spec.md §11`
