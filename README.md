# Promo Guard

Prevents repeat abuse of Shopify welcome offers by matching identity signals beyond email — phone, address, device/IP, similar email variants.

Supports Basic, Shopify, and Advanced plans. Plus and Starter are not supported.

## Stack

- React Router (Remix successor) for the embedded admin app + public site
- Prisma + Postgres (local dev via docker-compose, Neon in production)
- Rust Shopify Functions for checkout-time validation and discount logic
- Shared Rust crate (`shared-rust/`) is the single source of truth for normalize + hash + scoring
- Cloud Run for production hosting

## Quickstart

```bash
make setup   # install deps, start local DB, migrate, seed
make dev     # Remix + Shopify CLI + worker + DB
make verify  # lint + typecheck + test (what CI runs)
```

More targets in `Makefile`.

## Project docs

Start with `CLAUDE.md` — the spec index and hard rules. Architecture lives in `docs/system-design.md`. Polaris UI standards in `docs/polaris-standards.md`.
