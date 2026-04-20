# Promo Guard

Prevent repeat abuse of Shopify welcome offers by matching identity signals beyond email (phone, address, device/IP, similar email variants). Basic / Shopify / Advanced plans — no Plus, no Starter.

## Hard rules

- NEVER put raw PII in a Shopify metafield. Only hashes + MinHash sketches.
- NEVER change normalization without bumping the version in `docs/normalization-spec.md §11` AND rebuilding `docs/test-fixtures/hash-vectors.json`.
- NEVER add a merchant-facing setting that isn't already in `docs/admin-ui-spec.md`.
- NEVER use the `orders/create` webhook. Use `orders/paid`.
- NEVER exceed 30 query cost or 128 KB input in a Function (see `docs/function-queries-spec.md §1`).
- NEVER store a protected discount's raw code in logs. Hash or redact.
- NEVER log decrypted PII. Decryption is in-memory only, scoped narrowly.
- ALWAYS run `make verify` before committing.

## CLI-first

If a CLI scaffolds it, use the CLI — never hand-write what a tool generates. Shopify app scaffolds, Prisma migrations, `npm install`, `cargo add` — all via CLI. If a CLI prompts for input interactively, stop and ask the user to run it themselves. Details: `.claude/rules/shopify-functions.md`.

## Spec index

| Question | Doc |
|---|---|
| Architecture | `docs/system-design.md` |
| DB schema + compliance | `docs/database-design.md` |
| Normalization + MinHash | `docs/normalization-spec.md` |
| Scoring + thresholds | `docs/scoring-spec.md` |
| Function queries + output | `docs/function-queries-spec.md` |
| Webhooks + job queue | `docs/webhook-spec.md` |
| Merchant admin UI | `docs/admin-ui-spec.md` + `docs/polaris-standards.md` |
| Public marketing site | `docs/landing-page-spec.md` |
| Internal admin tool | `docs/platform-admin-spec.md` |
| Scheduled jobs | `docs/cron-setup.md` |

## AI must NOT

- Run `prisma migrate deploy` against production
- Call Shopify Admin API against a real shop outside dev stores
- Change any hard rule here without explicit user approval
- Add libraries without noting the reason in the commit body
- Invent features not in the specs — update the spec first, then implement

## Knowledge graph

Use graphify before Grep/Glob/Read for codebase exploration. Graph artifacts live in `graphify-out/` (gitignored). Usage: `.claude/rules/mcp-tools.md`.
