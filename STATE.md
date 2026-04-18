# STATE

Resume pointer for the autonomous build coordinator. See `docs/build-run-prompt.md` for usage.

Status markers:
- `☑` completed
- `⚠` blocked — user action needed (see BLOCKED section below)
- `⊖` deferred — waiting on a blocked dependency
- `☐` pending

## Current

**Last task completed:** none
**Next task:** T01 (docker-compose.yml for local Postgres)
**Run mode:** awaiting first run
**Last updated:** (initial)

## Completed

(empty)

## Blocked

(empty — will be populated during unattended runs)

Format for each entry:
```
### T<xx> — <title>
**Failed at:** <timestamp>
**Why:** <one-line reason>
**What the user must do:**
  - <concrete action>
**Where:** <file path or command>
```

## Deferred

(empty)

## Recent events

(empty — first run)

## Auto-generated during pre-flight

When the coordinator's pre-flight runs, it will write here what it generated
and what still needs the user:

```
Generated:
  - APP_KEK_HEX
  - SESSION_SECRET

Placeholders needing real values:
  - SHOPIFY_API_KEY              (Partner Dashboard → App → Client ID)
  - SHOPIFY_API_SECRET           (Partner Dashboard → App → Client secret)
  - SHOPIFY_APP_URL              (your deployed URL or ngrok)
  - PLATFORM_ADMIN_ALLOWED_EMAILS (your own email, comma-separated list)
  - DATABASE_URL                 (Neon pooled connection string)
  - DIRECT_DATABASE_URL          (Neon unpooled connection string)
```
