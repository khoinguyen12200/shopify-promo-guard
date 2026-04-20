# Promo Guard — Build Plan

Status: **54/56 tasks done**. Remaining work is external Shopify submission.

## Remaining

### ⚠ T55. Protected customer data application
Manual submission via Partner Dashboard. Copy source: `docs/landing-page-spec.md §7` + `docs/system-design.md § Privacy`. Required: Level 1 + Level 2 granted before App Store submission.

### ⚠ T56. App Store listing + review submission
Listing copy, screenshots, icon, demo video. Spec: `docs/landing-page-spec.md §15`. Depends on T54, T55.

## Housekeeping for new work

- Commit message: `feat/fix/chore: <title>` (or `Txx: <title>` if continuing numbered tasks)
- `make verify` must pass before every commit
- If a spec changes, update it in the same commit
- If a new task emerges, append (`T57`, `T58`, …) — don't renumber
