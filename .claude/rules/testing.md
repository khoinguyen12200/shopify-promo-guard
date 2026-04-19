---
paths:
  - "app/**/*.ts"
  - "app/**/*.tsx"
  - "extensions/**/*.rs"
  - "shared-rust/**/*.rs"
---

# Testing Standards

## Required
- Run `make verify` (lint + typecheck + test) before every commit — failing on main is stop-the-line
- New normalization/hash logic must have corresponding fixtures in `docs/test-fixtures/hash-vectors.json`
- Rust and Node test suites must produce identical output for shared fixtures (parity enforced by `make test`)

## Test Commands
- All tests: `make test`
- Node only: `npm test` (Vitest)
- Rust only: `cargo test` (inside the extension or shared-rust directory)
- Fixture parity: included in `make test`

## Fixture Parity
- `docs/test-fixtures/hash-vectors.json` is the shared source of truth
- Both Rust (`cargo test`) and Node (`npm test`) suites read it
- If normalization changes, regenerate fixtures and bump version before committing

## No Mocking the Database
- Integration tests hit the real local Postgres (docker-compose, port 5434)
- Mocked DB tests have caused prod divergence before — avoid
