# Promo Guard

Prevent repeat abuse of Shopify welcome offers by matching identity signals beyond email (phone, address, device/IP, similar email variants). Works on Basic / Shopify / Advanced plans — no Plus required, Starter excluded.

## Session ritual

1. Skim this file (you're here).
2. Open `docs/build-plan.md`. Find the next unchecked task.
3. Read only the spec sections that task references. Don't load everything.
4. Work on that one task. One task, one session, one commit.
5. Before committing: `make verify` must pass.
6. Mark the task checkbox done in `docs/build-plan.md`, commit with message `Txx: <task title>`.
7. Stop — unless the user queues the next task.

If a task reveals a spec is wrong, fix the spec in the same commit and note it in the body.

## Hard rules

- NEVER put raw PII in a Shopify metafield. Only hashes + MinHash sketches.
- NEVER change normalization without bumping the version in `docs/normalization-spec.md §11` AND rebuilding `docs/test-fixtures/hash-vectors.json`.
- NEVER add a merchant-facing setting that isn't already in `docs/admin-ui-spec.md`.
- NEVER use the `orders/create` webhook. Use `orders/paid`.
- NEVER exceed 30 query cost or 128 KB input in a Function (limits from `docs/function-queries-spec.md §1`).
- NEVER store a protected discount's raw code in logs. Hash or redact.
- NEVER log decrypted PII. Decryption happens only in-memory in one function, then drops scope.
- ALWAYS run `make verify` before committing. A failing `make verify` on `main` is a stop-the-line event.

## CLI-first rule

When a CLI can scaffold or modify a file, USE the CLI. Never hand-write what a tool generates — it's a source of bugs and version drift.

| Doing this | Use this |
|---|---|
| Scaffolding a Function extension | `shopify app generate extension --template <kind> --flavor rust --name <name>` |
| Scaffolding a UI extension | `shopify app generate extension --template ui_extension` |
| Scaffolding a webhook or admin UI extension | `shopify app generate extension --template admin_action` etc. |
| Downloading a Function schema | `shopify app function schema --stdout > schema.graphql` |
| Creating/changing Prisma models | edit `prisma/schema.prisma` then `npx prisma migrate dev --name <slug>` |
| Generating the Prisma client | `npx prisma generate` |
| Running a Function locally | `shopify app function run --input=<file> --export=<name>` |
| Installing a Node dep | `npm install <pkg>` (never hand-edit `package.json` deps) |
| Installing a Rust dep | `cargo add <pkg>` in the crate's directory (if allowed; Function crates have tight restrictions) |
| Creating a new Remix route | touch a file at the conventional path — no CLI needed, but follow the route-name conventions in `docs/admin-ui-spec.md` |

If a CLI command is interactive (prompts for input), stop and ask the user to run it themselves — do not try to guess answers.

## Spec index

| Question | Doc |
|---|---|
| High-level architecture | `docs/system-design.md` |
| Database schema + compliance flows | `docs/database-design.md` |
| Email/phone/address normalization + MinHash | `docs/normalization-spec.md` |
| Scoring weights + decision thresholds | `docs/scoring-spec.md` |
| Function GraphQL queries + output shapes | `docs/function-queries-spec.md` |
| Webhook handlers + job queue | `docs/webhook-spec.md` |
| Merchant-facing UI (inside Shopify embed) | `docs/admin-ui-spec.md` |
| Public marketing site | `docs/landing-page-spec.md` |
| Internal team admin tool | `docs/platform-admin-spec.md` |
| Build/wire/context strategy | `docs/build-orchestration-spec.md` |

## Infrastructure

- **Local dev DB**: Postgres 16 via `docker-compose.yml` (port 5434).
- **Production DB**: Neon Postgres. `DATABASE_URL` (pooled) + `DIRECT_DATABASE_URL` (unpooled, for migrations).
- **Hosting**: GCP Cloud Run, pattern mirrors `~/Projects/shopify-repair-ops`:
  - Artifact Registry for container images
  - Cloud Build pipeline (`cloudbuild.yaml`): build → migrate → push → deploy
  - Separate `Dockerfile.dev` and `Dockerfile.prod`
  - Regions: `us-central1`
- **Secrets**: GCP Secret Manager for Neon URLs, Shopify API secret, app KEK, magic-link secret.
- **Background worker**: Cloud Run Job (scheduled or triggered) OR a second Cloud Run service — decide at T54.

## Commands

```bash
make setup       # first-time init: deps, DB up, migrate, schemas, seed
make dev         # start all dev processes (Remix + Shopify CLI + worker + db)
make build       # production artifacts (Remix bundle, Function wasm binaries)
make test        # all tests: Node (Vitest), Rust (cargo test), fixture parity
make verify      # lint + typecheck + test (what CI runs)
make clean       # remove generated artifacts, stop docker
```

More targets in `Makefile` (db-reset, db-studio, functions-schema, etc.).

## Key paths

```
app/                                Remix app (embedded, public, platform admin)
app/routes/app.*.tsx                merchant UI (embedded in Shopify)
app/routes/_public.*.tsx            public marketing site
app/routes/admin.*.tsx              internal platform admin
app/routes/webhooks.*.tsx           Shopify webhook receivers
app/lib/                            Node services (normalize, hash, scoring, crypto)
app/jobs/                           background job handlers
app/workers/worker.ts               job queue runner entrypoint
prisma/schema.prisma                DB schema — source of truth is docs/database-design.md
shared-rust/                        single source of truth for Rust normalize/hash/scoring
extensions/promo-guard-validator/   Cart & Checkout Validation Function (Rust)
extensions/promo-guard-discount/    Discount Function (Rust)
extensions/promo-guard-order-block/ Admin UI extension — order details block
docs/                               all specs (see index above)
docs/test-fixtures/                 JSON fixtures that enforce Node/Rust parity
scripts/                            dev scripts (seed, migrate-helpers, etc.)
docker-compose.yml                  local Postgres
Dockerfile.dev / Dockerfile.prod    GCP Cloud Run images
cloudbuild.yaml                     GCP deploy pipeline
Makefile                            one-command orchestrator
```

## File-header convention

Every new source file starts with a comment linking to its spec:

```typescript
/**
 * See: docs/webhook-spec.md §5 (orders/paid handler)
 * Related: docs/scoring-spec.md §5.2 (post-order scoring)
 */
```

Two lines max. Makes every file self-describing; any future AI reading it knows where to go.

## Drift prevention

- **Fixture parity**: `docs/test-fixtures/hash-vectors.json` is read by both Rust and Node test suites. If output diverges, `make verify` fails.
- **Spec version**: `docs/normalization-spec.md §11` has a version marker; shards tag their content with it. Changing normalization = bumping version = rebuild shards.
- **Spec-code links**: file headers (above). If you rename a spec section, grep for its ID and update the headers.

## What the AI must NOT do on its own

- Push to `main` without PR
- Run `prisma migrate deploy` against production
- Call Shopify Admin API against a real shop outside dev stores
- Change any hard rule in this file without explicit user approval
- Add libraries not already in `package.json` / `Cargo.toml` without noting the reason in the commit body
- Invent features not in the specs — instead, update the spec first, then implement
