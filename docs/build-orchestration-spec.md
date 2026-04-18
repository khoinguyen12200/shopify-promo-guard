# Promo Guard — Build Orchestration & Context Stability

How we keep every AI coding session anchored to the same decisions, and how one command boots the whole project.

Three concerns, one system:

1. **Context stability** — prevent AI drift over long sessions and across fresh sessions.
2. **Wiring** — every spec document maps to code paths; every code file traces back to a spec.
3. **One-command build** — `make setup && make dev` and the project runs.

---

## 1. Problem

Over a long session, an AI agent can:
- Forget a decision made 40 messages ago.
- Re-invent something already specified in a doc it hasn't re-read.
- Drift style (naming, file layout, error handling) from earlier work.

And across fresh sessions, a new AI starts with zero memory. Without a deliberate re-hydration strategy, the second session re-derives what the first session already decided — differently.

The docs we have (9 specs) solve half the problem: they are the source of truth. The other half is making sure every session loads them the same way.

---

## 2. The three-layer anchor

### Layer 1 — `CLAUDE.md` at project root (always in context)

One file the AI loads automatically on every session. Under 200 lines. Contains:

- Project vision in 2 sentences.
- Architecture in one diagram.
- Hard constraints (what NEVER to do).
- Links to each spec with a one-line description.
- Start-of-session ritual: "Read `docs/build-plan.md` for current task."

This file is NOT a spec. It's a table of contents + guardrails. It gets re-read every session and fits in cache cheaply.

### Layer 2 — `docs/` (detail, loaded on demand)

Our existing 9 specs. Each one answers ONE question:

| If the agent asks… | Read this |
|---|---|
| "How do email hashes work?" | `docs/normalization-spec.md` |
| "What's the DB schema?" | `docs/database-design.md` |
| "What does the merchant see?" | `docs/admin-ui-spec.md` |
| "What's the Function input query?" | `docs/function-queries-spec.md` |
| "How does the webhook handler flow?" | `docs/webhook-spec.md` |
| "What do weights equal?" | `docs/scoring-spec.md` |
| "What does the landing page look like?" | `docs/landing-page-spec.md` |
| "What's the internal admin tool?" | `docs/platform-admin-spec.md` |
| "High-level architecture?" | `docs/system-design.md` |

`CLAUDE.md` has this table, so the AI opens the right file immediately.

### Layer 3 — `docs/build-plan.md` (what to do right now)

Linear, ordered list of atomic tasks. Each task:

- Has an ID like `T01`, `T02`.
- Names the spec sections it implements.
- Lists every file it creates or edits.
- Defines acceptance criteria (tests pass, CLI command succeeds).
- Declares dependencies on prior task IDs.
- Has a status checkbox (pending / in-progress / done).

The AI, at the start of any session, does:
1. Read `CLAUDE.md`.
2. Read `docs/build-plan.md`.
3. Find the next unchecked task.
4. Read the spec sections that task references.
5. Work on ONE task. Mark it done.
6. Commit.
7. Stop. (Or loop to next task if the user wants.)

One task, one session. If a task is too big for one session, it gets split at plan time.

---

## 3. The one-command build

A `Makefile` at project root. Everything else is composed from its targets.

### Top-level targets

```
make setup        ← first-time initialization (one-time per clone)
make dev          ← start all dev processes (Remix app + Shopify CLI + worker)
make build        ← production build of everything (Remix + Functions + extensions)
make test         ← run all test suites (Node, Rust, integration)
make verify       ← lint + typecheck + test — what CI runs on every PR
make clean        ← remove all generated artifacts
```

### `make setup` — what it does

```
1. Check prerequisites:
   - Node 20+ (fail with install instructions if missing)
   - Rust + rustup + cargo + wasm32-wasip1 target
   - Docker or Postgres available locally
   - shopify CLI installed globally
2. npm install (top-level Remix app + worker)
3. For each extension under extensions/*:
   - cargo fetch (Rust deps) OR npm install (JS deps) as appropriate
4. Generate Prisma client: npx prisma generate
5. Run migrations on the dev DB: npx prisma migrate dev --name init
6. Seed dev DB with a fake shop + sample data: node scripts/seed-dev.js
7. Generate Function schemas for type-safe Rust: shopify app function schema --stdout > extensions/*/schema.graphql
8. Print next steps: "Run `make dev` to start."
```

Idempotent — running it twice does nothing bad. Installs are cached, migrations are no-ops if already applied, seeds only run if DB is empty.

### `make dev` — what it runs concurrently

Three processes in parallel, with color-prefixed logs:

```
[remix ]  shopify app dev             ← Remix + Shopify CLI tunnel
[worker]  npm run worker              ← job queue processor
[prisma] npx prisma studio --browser none ← DB GUI at localhost:5555
```

`shopify app dev` itself handles:
- Building the Remix app in watch mode.
- Building each Function extension in watch mode.
- Tunneling via cloudflared to a public URL so Shopify webhooks can reach localhost.
- Reloading when source files change.

### `make build`

Production artifacts only. No watchers, no tunnels.

```
1. npm run build                              ← compiles Remix for production
2. For each function extension:
     shopify app function build               ← produces .wasm
3. For each UI extension:
     (Shopify CLI handles this inside the Remix build)
4. Verify each .wasm is under 256 KB
5. Verify Remix bundle size targets
```

### `make test`

```
1. Node tests:  npm test                      ← Vitest for Remix routes + services
2. Rust tests: cd extensions/* && cargo test  ← Function logic, normalization, scoring
3. Shared fixture test: verify docs/test-fixtures/hash-vectors.json
   produces identical output in Node and Rust (Layer 1 of the
   normalization spec's contract enforcement)
4. Integration tests: docker-compose up the test stack, run E2E
```

The shared fixture test is the most important one — it's what keeps the Node and Rust implementations byte-identical. CI fails if they drift.

### `make verify`

What CI runs. Composes smaller targets:

```
make verify = make lint && make typecheck && make test
```

Every PR must pass `make verify` before merge.

---

## 4. How wiring maps to the file system

One mental rule: **every spec section corresponds to a file or folder; every file has a comment pointing to its spec.**

```
docs/system-design.md            ───► app/services/*   (high-level)
docs/database-design.md          ───► prisma/schema.prisma
docs/normalization-spec.md       ───► app/lib/normalize.server.ts
                                 ───► shared-rust/src/normalize.rs
docs/scoring-spec.md             ───► app/lib/scoring.server.ts
                                 ───► shared-rust/src/scoring.rs
docs/function-queries-spec.md    ───► extensions/promo-guard-validator/src/run.graphql
                                 ───► extensions/promo-guard-discount/src/*.graphql
docs/webhook-spec.md             ───► app/routes/webhooks.*.tsx
                                 ───► app/jobs/*.ts
docs/admin-ui-spec.md            ───► app/routes/app.*.tsx
                                 ───► app/components/*
docs/landing-page-spec.md        ───► app/routes/_public.*.tsx
docs/platform-admin-spec.md      ───► app/routes/admin.*.tsx
```

Each implementation file has a header:

```typescript
/**
 * See: docs/webhook-spec.md §5 (orders/paid handler)
 * Maps to: Prisma RedemptionRecord, FlaggedOrder
 */
```

This 2-line convention makes every file self-describing. An AI reading this file knows where to go for the full context without reading the whole repo.

---

## 5. Shared code between Node and Rust

The tightest coupling is normalization + scoring, which must produce byte-identical output across both runtimes. Strategy:

```
shared-rust/                        ← single Rust source of truth for normalize + hash + scoring
  src/
    normalize.rs
    hash.rs
    scoring.rs
    constants.rs
  Cargo.toml

extensions/promo-guard-validator/
  src/
    run.rs
    run.graphql
    scoring_adapter.rs              ← adapter that calls into ../shared-rust
  Cargo.toml                         ← depends on ../shared-rust via path

extensions/promo-guard-discount/
  src/
    cart_lines_discounts_generate_run.rs
    cart_lines_discounts_generate_run.graphql
    scoring_adapter.rs
  Cargo.toml                         ← depends on ../shared-rust via path

app/lib/                             ← Node mirrors
  normalize.server.ts                ← ports shared-rust/normalize.rs 1:1
  hash.server.ts                     ← ports shared-rust/hash.rs 1:1
  scoring.server.ts                  ← ports shared-rust/scoring.rs 1:1
```

The port from Rust to TypeScript is done once by hand, and locked in by:

### The fixture-vector test

A single JSON file `docs/test-fixtures/hash-vectors.json` contains input/output pairs. Both the Rust and Node test suites read this file and assert their implementation produces the documented output. If we ever change normalization, we update the fixture + bump the version in normalization spec §11, and both sides re-verify.

This is the anchor that prevents the two implementations from drifting. It runs in `make test`.

---

## 6. Session ritual (what the AI does each time)

The AI's behaviour is scripted by `CLAUDE.md`:

```
On every new session:
  1. Read CLAUDE.md (you're doing it now — this file stays < 200 lines)
  2. Read docs/build-plan.md
  3. Find the first unchecked task
  4. Read only the spec sections that task references (don't load everything)
  5. Work on that one task
  6. When done:
     - Run `make verify` and only proceed if it passes
     - Mark the task checkbox in docs/build-plan.md
     - Commit with message "Txx: <task title>"
     - Stop. Or ask the user to queue the next task.
```

End-of-session discipline:
- Every commit message starts with the task ID.
- Every spec deviation is called out in the commit body.
- If a task reveals a spec is wrong, update the spec as part of the same commit and note it in the commit body.

---

## 7. Concrete next actions

Three files to create when we start implementation:

### 7.1 `CLAUDE.md` at project root (always loaded)

Template:

```markdown
# Promo Guard

Prevent repeat abuse of Shopify welcome offers by matching identity signals beyond email.
Works on Basic/Shopify/Advanced plans. No Plus required.

## Session ritual

1. Skim this file.
2. Open docs/build-plan.md.
3. Do the next unchecked task.
4. Run `make verify`.
5. Mark task done, commit, stop.

## Hard rules

- NEVER put raw PII in a Shopify metafield. Only hashes + MinHash sketches.
- NEVER change normalization without bumping the version in docs/normalization-spec.md and rebuilding the fixture.
- NEVER add a merchant-facing setting that isn't already in docs/admin-ui-spec.md.
- NEVER use `orders/create`. Use `orders/paid`.
- NEVER exceed 30 query cost or 128 KB input in a Function.

## Spec index

| Question | Doc |
|---|---|
| High-level architecture | docs/system-design.md |
| DB schema | docs/database-design.md |
| Normalization + hashing | docs/normalization-spec.md |
| Scoring algorithm | docs/scoring-spec.md |
| Function GraphQL | docs/function-queries-spec.md |
| Webhook handlers | docs/webhook-spec.md |
| Merchant UI | docs/admin-ui-spec.md |
| Public marketing site | docs/landing-page-spec.md |
| Internal admin tool | docs/platform-admin-spec.md |

## Build

- `make setup`  — first-time init
- `make dev`    — start all dev processes
- `make verify` — CI check
- `make build`  — production artifacts
```

### 7.2 `Makefile` at project root

Orchestrator described in §3 above. Concrete target implementations written when we start.

### 7.3 `docs/build-plan.md`

The ordered task list. Every task is atomic. Example shape:

```markdown
# Build Plan

## T01. Prisma schema from database-design.md
**Status:** ☐ pending
**Specs:** docs/database-design.md §entire
**Files:**
  - prisma/schema.prisma (rewrite)
  - prisma/migrations/* (generated)
**Acceptance:**
  - `npx prisma migrate dev --name init` succeeds
  - `npx prisma generate` succeeds
  - Every model from the spec is present

## T02. Per-shop salt + encryption key generation
**Status:** ☐ pending
**Specs:** docs/database-design.md §"Encryption approach"
**Depends:** T01
**Files:**
  - app/lib/crypto.server.ts
  - app/lib/shop.server.ts
**Acceptance:**
  - Shop.salt is 32 bytes hex on install
  - Shop.encryptionKey is wrapped by KMS and decryptable
  - Unit tests cover happy path + key rotation

## T03. Normalization library (Node)
**Status:** ☐ pending
**Specs:** docs/normalization-spec.md §1-§7
**Depends:** none
**Files:**
  - app/lib/normalize.server.ts
  - app/lib/hash.server.ts
  - docs/test-fixtures/hash-vectors.json (seed with §9 vectors)
**Acceptance:**
  - All test vectors in §1-§6 pass
  - FNV-1a matches the canonical test values (`"a"` → `0xe40c292c` etc.)

... (continues for every task through deploy)
```

We build the full `build-plan.md` when you greenlight this approach.

---

## 8. Why this works

- **`CLAUDE.md` stays loaded cheaply** — short enough that every session re-reads it without burning context.
- **Specs are loaded on demand** — the AI doesn't re-read 3000 lines of specs when building a small feature; it loads only the referenced sections.
- **Build plan is the scheduler** — atomic tasks mean no session needs more than ~500 lines of context.
- **Fixture tests enforce cross-language contracts** — the Node/Rust scoring contract can't silently drift.
- **`make verify` is the gate** — if tests pass, the change is by definition consistent with the code; if they fail, the AI must fix before moving on.
- **Commit messages tie back to task IDs** — `git log` is a reliable history of what was actually built.

---

## 9. Trade-offs / risks acknowledged

- **Build plan must be maintained.** If we deviate, we update it. Staleness = AI drift.
- **`CLAUDE.md` must stay under 200 lines.** Temptation to bloat it. Resist.
- **Shared-rust → TypeScript port is manual for MVP.** Future: generate TypeScript from Rust via a tool like `ts-rs`. Not in scope now.
- **Fixture vectors need to be exhaustive.** A normalization bug not covered by fixtures won't be caught. Budget time to grow the fixture set.

---

## 10. What we build right now vs. later

### Create now (when user greenlights)

- `CLAUDE.md` at project root
- `Makefile` with stub targets
- `docs/build-plan.md` with tasks T01..Tn fully enumerated
- `docs/test-fixtures/hash-vectors.json` (empty shape, filled during T03)

### Create during build (task by task)

- Every code file listed in every task
- Every test
- Every spec update made in-task

### Not building (explicit non-goals)

- AI-agent orchestration frameworks (Langchain, CrewAI etc.) — we don't need them; Claude + these docs is enough
- Auto-generated code from specs — premature; the specs are stable, the ports are one-time
- Monorepo tooling (Nx, Turborepo) — overkill for 3 subdirectories

---

## 11. One more safeguard: the `STATE.md` hand-off file

Optional, for very long sessions or session handoffs. Between tasks, the agent writes a one-paragraph `STATE.md` at project root:

```markdown
# STATE

Last task completed: T07 (webhook-auth middleware)
Next task: T08 (orders/paid handler)
Blockers: none
Recent gotcha: Prisma's upsert on WebhookEvent needed a unique constraint bump (logged in commit abc123)
```

The next session reads this first, then `CLAUDE.md`, then `docs/build-plan.md`. This closes the loop across sessions without requiring the user to re-brief.

---

## 12. Decision checkpoint

Before building, confirm:

- [ ] Approve the `CLAUDE.md` + `Makefile` + `docs/build-plan.md` triangle
- [ ] Approve the fixture-vector strategy for Node/Rust parity
- [ ] Approve the "one task, one session, one commit" discipline
- [ ] Approve using `make` over alternatives (npm scripts, Task, Just)
- [ ] Greenlight me to write `CLAUDE.md` + `Makefile` stub + `docs/build-plan.md`

When you say go, those three files are the next thing I write (same session, no coding yet). Then we start on T01 whenever you say.
