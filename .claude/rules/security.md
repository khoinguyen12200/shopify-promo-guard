---
paths:
  - "app/**/*.ts"
  - "app/**/*.tsx"
  - "app/lib/**/*.ts"
  - "app/routes/webhooks.*.tsx"
---

# Security Requirements

## PII Handling
- NEVER store raw PII in Shopify metafields — only hashes and MinHash sketches
- NEVER log decrypted PII; decryption is in-memory only, then drops scope
- NEVER put raw discount codes in logs — hash or redact before logging

## Webhook Security
- All webhook endpoints must verify Shopify HMAC signature before processing
- NEVER use `orders/create` webhook — use `orders/paid` only

## Input Validation
- Validate all inputs at system boundaries (user input, webhook payloads)
- Use parameterized Prisma queries — no raw SQL string concatenation

## Secrets
- NEVER commit secrets, API keys, or credentials to git
- NEVER put secrets in `settings.json` (shared/committed) — use GCP Secret Manager
- All secrets are injected at runtime via environment variables

## Normalization Versioning
- Changing normalization logic requires bumping the version in `docs/normalization-spec.md §11`
- AND rebuilding `docs/test-fixtures/hash-vectors.json`
