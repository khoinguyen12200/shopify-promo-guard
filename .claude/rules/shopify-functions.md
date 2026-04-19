---
paths:
  - "extensions/**/*.rs"
  - "extensions/**/*.graphql"
  - "extensions/**/*.toml"
  - "shared-rust/**/*.rs"
---

# Shopify Functions Rules

## Hard Limits (from docs/function-queries-spec.md §1)
- Max GraphQL query cost: 30
- Max input size: 128 KB
- Exceeding either limit causes the Function to be rejected at deploy time

## Scaffolding
- Always scaffold new Function extensions with the CLI:
  `shopify app generate extension --template <kind> --flavor rust --name <name>`
- Never hand-write what the CLI generates

## Schema
- Download the Function schema with:
  `shopify app function schema --stdout > schema.graphql`
- Run locally with:
  `shopify app function run --input=<file> --export=<name>`

## Rust Crate Rules
- Keep dependencies tight — Function crates have strict restrictions
- Use `cargo add <pkg>` to add dependencies (not hand-editing `Cargo.toml`)
- Shared logic lives in `shared-rust/` — don't duplicate normalization or hash logic in extensions

## Discount Codes
- NEVER store a protected discount's raw code in logs — hash or redact
