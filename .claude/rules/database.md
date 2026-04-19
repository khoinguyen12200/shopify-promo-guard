---
paths:
  - "prisma/**/*"
  - "app/lib/**/*.ts"
  - "app/jobs/**/*.ts"
---

# Database Guidelines

## Source of Truth
- `prisma/schema.prisma` is the code source of truth
- `docs/database-design.md` is the spec source of truth — keep them in sync

## Migrations
- Create/change models: edit `prisma/schema.prisma` then run:
  `npx prisma migrate dev --name <slug>`
- Generate Prisma client after schema changes:
  `npx prisma generate`
- NEVER run `prisma migrate deploy` against production manually

## PII Compliance
- Raw PII (email, phone, address) must NOT be stored in metafields
- Only hashes and MinHash sketches go in Shopify metafields
- Compliance flows are documented in `docs/database-design.md`

## Local Dev
- DB runs at `postgresql://promo:promo@localhost:5434/promo_guard` via docker-compose
- Production DB is Neon Postgres (pooled `DATABASE_URL` + unpooled `DIRECT_DATABASE_URL`)
- Use `make db-studio` for Prisma Studio GUI
- Use `make db-reset` to reset local DB (destructive — confirm first)
