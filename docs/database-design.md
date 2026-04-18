# Promo Guard — Database Design

Prisma schema backing the system design. Every table maps to a system-design component; every column has a purpose.

Source of truth: **Prisma + Postgres in production, SQLite in dev** (Shopify Remix template default is SQLite; swap at deployment).

---

## Design principles

1. **One row per logical event** — no premature normalization. A redemption is one row, not four signal rows.
2. **Hash columns are indexed; raw PII columns are encrypted.** Raw PII supports authoritative post-order scoring and compliance deletion; hashes support fast lookups.
3. **Per-shop salt** — hashes are scoped to a shop, preventing cross-shop correlation if the DB leaks.
4. **Soft deletes for merchant-facing entities** (Shop, ProtectedOffer) so audit history survives re-installs.
5. **Extensible by design** — enums are stored as strings (not tight Prisma enums) so adding new signal types, modes, or job kinds is a code change, not a migration.
6. **Denormalized Shopify IDs** (GIDs) on every record that references Shopify, so we can resync without a join to Shop.

---

## Entity overview

```
  Shop (install-scoped)
    │
    ├── ProtectedOffer (1..N per shop)
    │     │
    │     ├── ProtectedCode (1..N per offer — codes in the group)
    │     ├── RedemptionRecord (N per offer — every prior redemption)
    │     ├── FlaggedOrder (N per offer — post-order risk)
    │     └── ShardState (5 per offer — metafield ledger shards)
    │
    ├── Job (background work queue)
    ├── WebhookEvent (audit + dedup)
    ├── AuditLog (merchant actions)
    └── ComplianceRequest (GDPR data_request / redact)

  Session (Shopify template — unchanged)
```

---

## Models

```prisma
// -----------------------------------------------------------------------------
// Shop — one row per installed store
// -----------------------------------------------------------------------------

model Shop {
  id            String   @id @default(cuid())
  shopDomain    String   @unique                    // e.g. "foo.myshopify.com"
  accessToken   String                              // offline token (encrypted at rest)
  scope         String                              // granted OAuth scopes
  salt          String                              // 32-byte hex, per-shop hashing salt
  encryptionKey String                              // per-shop DEK (wrapped by app KEK)

  protectedDataLevel  Int       @default(0)         // 0 / 1 / 2
  timezone            String?                       // cached from shop query
  currencyCode        String?                       // cached

  installedAt    DateTime  @default(now())
  uninstalledAt  DateTime?                          // soft-delete marker

  protectedOffers    ProtectedOffer[]
  redemptionRecords  RedemptionRecord[]
  flaggedOrders      FlaggedOrder[]
  jobs               Job[]
  webhookEvents      WebhookEvent[]
  auditLogs          AuditLog[]
  complianceRequests ComplianceRequest[]

  @@index([uninstalledAt])
}


// -----------------------------------------------------------------------------
// ProtectedOffer — a group of codes treated as one welcome program
// -----------------------------------------------------------------------------

model ProtectedOffer {
  id              String   @id @default(cuid())
  shopId          String
  name            String                              // merchant-facing label
  mode            String                              // "silent_strip" | "block"
  status          String   @default("active")         // "active" | "paused" | "archived"

  shardVersion    Int      @default(0)                // bumps on every shard rebuild
  coldStartStatus String   @default("pending")        // "pending" | "running" | "complete" | "failed"
  coldStartDone   Int      @default(0)
  coldStartTotal  Int      @default(0)

  validationFunctionActivated  Boolean  @default(false)   // merchant flipped the Checkout Rules switch
  discountIdAppOwned           String?                    // if mode=silent_strip and we created a discount

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  archivedAt  DateTime?

  shop               Shop                @relation(fields: [shopId], references: [id], onDelete: Cascade)
  codes              ProtectedCode[]
  redemptionRecords  RedemptionRecord[]
  flaggedOrders      FlaggedOrder[]
  shardStates        ShardState[]

  @@index([shopId, status])
}


// -----------------------------------------------------------------------------
// ProtectedCode — individual discount codes within an offer
// -----------------------------------------------------------------------------

model ProtectedCode {
  id                 String   @id @default(cuid())
  protectedOfferId   String
  code               String                              // case-insensitive in Shopify; we store as typed
  codeUpper          String                              // uppercase normalized, for filtering

  discountNodeId         String?                         // current Shopify discount GID
  isAppOwned             Boolean  @default(false)        // did we create it via discountCodeAppCreate?
  replacedDiscountNodeId String?                         // archived original (for restore on uninstall)

  addedAt     DateTime @default(now())
  archivedAt  DateTime?

  protectedOffer ProtectedOffer @relation(fields: [protectedOfferId], references: [id], onDelete: Cascade)

  @@unique([protectedOfferId, codeUpper])
  @@index([codeUpper])
}


// -----------------------------------------------------------------------------
// RedemptionRecord — one row per successful redemption of a protected code
// -----------------------------------------------------------------------------

model RedemptionRecord {
  id                 String   @id @default(cuid())
  shopId             String
  protectedOfferId   String

  orderGid           String                              // gid://shopify/Order/123
  orderName          String                              // e.g., "#1042"
  codeUsed           String                              // which code was redeemed

  customerGid        String?                             // null for guest checkouts

  // Raw PII (encrypted with Shop.encryptionKey) — only for authoritative post-order scoring + compliance erasure
  emailCiphertext       String?
  phoneCiphertext       String?
  addressCiphertext     String?                          // JSON blob of {line1, line2, city, zip, country}
  ipCiphertext          String?

  // Hashes (salted with Shop.salt) — indexed for lookups
  phoneHash             String?                          // u32 hex, "" if missing
  emailCanonicalHash    String?
  addressFullHash       String?
  ipHash24              String?

  // MinHash sketches for fuzzy matching (JSON: [u32, u32, u32, u32])
  emailMinhashSketch    String?
  addressMinhashSketch  String?

  createdAt DateTime @default(now())

  shop           Shop            @relation(fields: [shopId], references: [id], onDelete: Cascade)
  protectedOffer ProtectedOffer  @relation(fields: [protectedOfferId], references: [id], onDelete: Cascade)

  @@unique([shopId, orderGid, protectedOfferId])
  @@index([shopId, protectedOfferId, phoneHash])
  @@index([shopId, protectedOfferId, emailCanonicalHash])
  @@index([shopId, protectedOfferId, addressFullHash])
  @@index([shopId, protectedOfferId, ipHash24])
  @@index([shopId, protectedOfferId, createdAt])        // for recency-based shard rebuild
  @@index([customerGid])                                 // for compliance erasure
}


// -----------------------------------------------------------------------------
// ShardState — tracks the 5 metafield shards per protected offer
// -----------------------------------------------------------------------------

model ShardState {
  id                 String   @id @default(cuid())
  protectedOfferId   String
  shardKey           String                              // "phones" | "emails_exact" | "emails_minhash" | "addrs_exact" | "addrs_minhash"

  metafieldGid       String?                             // Shopify metafield GID
  metafieldNamespace String                              // "$app"
  metafieldKey       String                              // e.g., "pg_<offerId>_phones"

  byteSize       Int      @default(0)                    // current size
  entryCount     Int      @default(0)
  oldestRecordId String?                                 // RedemptionRecord id of the oldest entry in the shard
  newestRecordId String?

  lastRebuiltAt  DateTime?
  version        Int      @default(0)                    // bumps every rebuild

  protectedOffer ProtectedOffer @relation(fields: [protectedOfferId], references: [id], onDelete: Cascade)

  @@unique([protectedOfferId, shardKey])
}


// -----------------------------------------------------------------------------
// FlaggedOrder — post-order risk flags (MEDIUM or HIGH)
// -----------------------------------------------------------------------------

model FlaggedOrder {
  id                 String   @id @default(cuid())
  shopId             String
  protectedOfferId   String

  orderGid           String
  orderName          String
  customerGid        String?

  riskLevel          String                              // "MEDIUM" | "HIGH"
  score              Int
  facts              String                              // JSON array of {signal, description, matchedRecordId}

  riskAssessmentGid  String?                             // from orderRiskAssessmentCreate
  tagged             Boolean  @default(false)

  merchantAction     String   @default("pending")        // "pending" | "dismissed" | "cancelled"
  merchantActionAt   DateTime?
  merchantActorId    String?                             // Shopify staff user GID, if available

  createdAt DateTime @default(now())

  shop           Shop           @relation(fields: [shopId], references: [id], onDelete: Cascade)
  protectedOffer ProtectedOffer @relation(fields: [protectedOfferId], references: [id], onDelete: Cascade)

  @@unique([shopId, orderGid])
  @@index([shopId, merchantAction])
  @@index([shopId, createdAt])
}


// -----------------------------------------------------------------------------
// Job — background work queue (cold-start backfill, shard rebuild, replace-in-place, etc.)
// -----------------------------------------------------------------------------

model Job {
  id         String   @id @default(cuid())
  shopId     String
  type       String                                    // "cold_start" | "shard_rebuild" | "replace_discount" | "backfill_risk"
  status     String   @default("pending")              // "pending" | "running" | "complete" | "failed"
  payload    String                                    // JSON
  progress   Int      @default(0)                      // 0..total
  total      Int      @default(0)
  error      String?
  attempts   Int      @default(0)

  createdAt    DateTime  @default(now())
  startedAt    DateTime?
  completedAt  DateTime?

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, status])
  @@index([status, createdAt])                          // worker poll
}


// -----------------------------------------------------------------------------
// WebhookEvent — idempotency + replay log for incoming Shopify webhooks
// -----------------------------------------------------------------------------

model WebhookEvent {
  id           String   @id @default(cuid())
  shopId       String
  topic        String                                  // e.g., "orders/paid"
  webhookGid   String   @unique                        // X-Shopify-Webhook-Id header — dedup key
  receivedAt   DateTime @default(now())
  processedAt  DateTime?
  status       String   @default("pending")            // "pending" | "processed" | "failed" | "skipped"
  error        String?
  payloadHash  String                                  // sha256 of body, for tamper-check audit

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, topic, receivedAt])
}


// -----------------------------------------------------------------------------
// AuditLog — merchant actions for support + compliance
// -----------------------------------------------------------------------------

model AuditLog {
  id          String   @id @default(cuid())
  shopId      String
  actorType   String                                   // "merchant" | "system" | "webhook"
  actorId     String?                                  // Shopify staff GID, or system component name
  action      String                                   // e.g., "offer.create", "flag.dismiss", "code.replace"
  targetType  String?                                  // e.g., "ProtectedOffer", "FlaggedOrder"
  targetId    String?
  metadata    String?                                  // JSON
  createdAt   DateTime @default(now())

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, createdAt])
  @@index([shopId, action])
}


// -----------------------------------------------------------------------------
// ComplianceRequest — GDPR mandatory webhooks
// -----------------------------------------------------------------------------

model ComplianceRequest {
  id           String   @id @default(cuid())
  shopId       String
  topic        String                                  // "customers/data_request" | "customers/redact" | "shop/redact"
  customerGid  String?                                 // null for shop/redact
  payload      String                                  // JSON (original Shopify payload)
  receivedAt   DateTime @default(now())
  completedAt  DateTime?
  status       String   @default("pending")            // "pending" | "completed" | "failed"
  error        String?

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, topic, status])
}


// -----------------------------------------------------------------------------
// Session — from Shopify Remix template (unchanged)
// -----------------------------------------------------------------------------

model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?
}
```

---

## How each table maps to the system design

| System design concept | Table(s) |
|---|---|
| Install / uninstall | `Shop` |
| Per-shop salt for hashing | `Shop.salt` |
| Per-shop encryption for raw PII | `Shop.encryptionKey` (wrapped by app-level KEK) |
| Protected offer (codes + mode) | `ProtectedOffer` + `ProtectedCode` |
| Replace-in-place (silent-strip of existing discount) | `ProtectedCode.replacedDiscountNodeId` |
| Authoritative ledger | `RedemptionRecord` |
| 5 sharded metafields | `ShardState` (one row per shard, 5 per offer) |
| Post-order flag | `FlaggedOrder` |
| Native Risk section attachment | `FlaggedOrder.riskAssessmentGid` |
| Cold-start backfill | `Job` with `type="cold_start"` |
| Shard rebuild after eviction | `Job` with `type="shard_rebuild"` |
| Webhook dedup | `WebhookEvent.webhookGid @unique` |
| GDPR `customers/data_request`, `customers/redact`, `shop/redact` | `ComplianceRequest` |
| Merchant UI actions (create, dismiss flag, cancel order) | `AuditLog` |

---

## Query patterns (what the indexes are for)

| Query | Index used |
|---|---|
| Post-order scoring: find matching records by phone hash | `(shopId, protectedOfferId, phoneHash)` |
| Same, email canonical | `(shopId, protectedOfferId, emailCanonicalHash)` |
| Same, address full | `(shopId, protectedOfferId, addressFullHash)` |
| Same, IP /24 | `(shopId, protectedOfferId, ipHash24)` |
| Rolling-window shard rebuild (N most recent) | `(shopId, protectedOfferId, createdAt)` |
| GDPR customer erasure | `(customerGid)` on RedemptionRecord |
| Merchant's "flagged orders — pending review" | `(shopId, merchantAction)` on FlaggedOrder |
| Webhook idempotency | `webhookGid @unique` |
| Worker pulls next pending job | `(status, createdAt)` on Job |

Fuzzy email/address match via MinHash is done **in app code** over a window of candidate records returned by the exact-hash indexes and recent-cursor queries. Postgres doesn't do MinHash natively; we don't want it to.

---

## Encryption approach

Two layers:

- **App KEK** (key-encrypting key) — a single master key in your secrets manager (AWS KMS / GCP KMS / env var for dev). Never touches the DB.
- **Per-shop DEK** (data encryption key) — 32 random bytes generated on shop install, encrypted by the KEK, stored in `Shop.encryptionKey`. Rotated on demand.

Raw PII columns (`emailCiphertext`, `phoneCiphertext`, `addressCiphertext`, `ipCiphertext`) are AES-256-GCM ciphertexts using the shop's DEK.

Why two layers:
- Rotating the app KEK doesn't require re-encrypting every row.
- `customers/redact` can zero out a shop's DEK to render all that shop's PII unreadable in one atomic step, as a belt-and-suspenders alongside row deletion.

Hash columns are NOT encrypted — they're already one-way and salted per-shop.

---

## Compliance flows (concrete)

### `customers/data_request`
1. `ComplianceRequest` row inserted.
2. Worker decrypts RedemptionRecord rows for this `customerGid`, exports JSON, delivers to merchant via configured channel.
3. Mark `completed`.

### `customers/redact`
1. `ComplianceRequest` row inserted.
2. Find all RedemptionRecord rows with `customerGid = X`.
3. Null out `*Ciphertext` columns and `*Hash` columns.
4. Remove entries from shard metafields; bump `ShardState.version`.
5. Keep the row (for referential integrity with FlaggedOrder) but with all PII removed.
6. Also delete matching `FlaggedOrder` rows' facts that reference the erased record.

### `shop/redact`
1. `ComplianceRequest` row inserted with 48-hour SLA.
2. Within 48 hours: cascade-delete the `Shop` row (which cascades to everything else).
3. Delete shop-owned Shopify metafields.

---

## Extensibility — how to add new things later

| Extension | Change |
|---|---|
| New signal type (e.g., device fingerprint) | Add column to `RedemptionRecord` (hash + ciphertext + sketch if fuzzy) + new `ShardState.shardKey` value. No enum change. |
| New risk level (e.g., LOW for analytics) | `FlaggedOrder.riskLevel` is a string — just start writing it. |
| New offer mode (e.g., "warn without blocking") | `ProtectedOffer.mode` is a string — add the value + code path. |
| Per-offer configurable scoring weights | Add `ProtectedOffer.scoringConfig String?` (JSON) — null means use defaults. |
| Cross-offer shared ledger | Add `ProtectedOffer.ledgerGroupId String?` — all offers with same group id share shards. |
| Additional shards | Add new `ShardState.shardKey` value + rebuild logic. Metafield namespace `$app` is flat. |
| New background job type | `Job.type` is a string — add new worker handler. |
| Merchant notification preferences | New `NotificationSetting` table joined to `Shop`. |

No enums to migrate. No tight coupling.

---

## Size estimates (sanity check)

For a store doing 1,000 redemptions/month:

| Table | Rows/month | Row size | Monthly growth |
|---|---|---|---|
| `RedemptionRecord` | 1,000 | ~800 B (ciphertexts + hashes + sketches) | ~800 KB |
| `FlaggedOrder` | ~50 (5% flag rate) | ~500 B | ~25 KB |
| `WebhookEvent` | ~3,000 (orders/paid + others) | ~300 B | ~900 KB |
| `AuditLog` | ~100 | ~300 B | ~30 KB |
| `Job` | ~10 | ~400 B | ~4 KB |

~1.7 MB/month per active store. A Postgres instance handles hundreds of shops comfortably.

Retention policy (future): archive `WebhookEvent` older than 30 days; archive `AuditLog` older than 2 years.

---

## Dev vs. production

- **Dev**: SQLite (already configured in `schema.prisma`). Some types (JSON, arrays) stored as strings. Adequate for a single developer.
- **Production**: Postgres. Swap the `datasource db` provider and use `json` columns where currently `String` (marked `// JSON`). Migration path is straightforward because Prisma detects schema diff.

---

## What's intentionally NOT in the schema

| Not here | Why |
|---|---|
| Scoring weights table | Using hardcoded constants for MVP. Add when a merchant asks. |
| Notification prefs table | Ship with email-only, add when needed. |
| Cross-shop correlation tables | Per-shop salt makes this impossible by design; add only if product pivots. |
| Per-customer-account balance of remaining redemptions | The ledger answers "was it redeemed" — no need for balances. |
| A/B test buckets | Wait for real experiments. |

---

## First migration (what we'll apply after this doc)

Apply `prisma migrate dev --name init_promo_guard` with the models above plus the existing `Session`. This produces the baseline schema that all subsequent code builds on.
