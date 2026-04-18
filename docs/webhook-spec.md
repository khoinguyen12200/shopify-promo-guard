# Promo Guard — Webhook Handler Spec

How the app receives, verifies, and processes every Shopify webhook it subscribes to.

---

## 1. Topics we subscribe to

| Topic | Purpose | Criticality | Scope required |
|---|---|---|---|
| `orders/paid` | Write ledger, create risk assessment, tag customer | core | `read_orders`, `write_orders`, `write_customers` |
| `app/uninstalled` | Soft-delete `Shop`, revoke session, stop workers | operational | none (fires automatically) |
| `customers/data_request` | GDPR export | compliance (mandatory) | `read_customers` |
| `customers/redact` | GDPR delete-on-behalf-of-customer | compliance (mandatory) | `write_customers` |
| `shop/redact` | GDPR full shop purge on uninstall-plus-48-hours | compliance (mandatory) | none |

We **do not** subscribe to `orders/create`. Shopify's docs explicitly warn its delivery timing is unreliable for real-time logic. `orders/paid` replaces it for our use case.

---

## 2. Subscription declaration

All webhooks are declared in `shopify.app.toml` so they apply to every install. The mandatory compliance topics also work via app configuration (no longer must be set in the Partner Dashboard).

```toml
[webhooks]
api_version = "2025-10"

[[webhooks.subscriptions]]
topics         = ["orders/paid"]
uri            = "/webhooks/orders/paid"
include_fields = [
  "id", "admin_graphql_api_id", "name", "created_at", "updated_at",
  "email", "phone",
  "customer",
  "discount_codes", "discount_applications",
  "shipping_address", "billing_address",
  "browser_ip", "client_details",
  "total_price", "currency"
]

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri    = "/webhooks/app/uninstalled"

[[webhooks.subscriptions]]
topics           = ["customers/data_request"]
uri              = "/webhooks/customers/data_request"
compliance_topics = ["customers/data_request"]

[[webhooks.subscriptions]]
topics           = ["customers/redact"]
uri              = "/webhooks/customers/redact"
compliance_topics = ["customers/redact"]

[[webhooks.subscriptions]]
topics           = ["shop/redact"]
uri              = "/webhooks/shop/redact"
compliance_topics = ["shop/redact"]
```

### `include_fields` for `orders/paid`

Drops every field we don't use. Reduces payload size ~10× vs the default order payload, speeds up handler, lowers parse cost. All fields listed map to something in the scoring path. If we add IP `/48` (IPv6) scoring later, add `client_details.browser_ip` already covered by `client_details`.

---

## 3. Delivery guarantees (what Shopify promises us)

From Shopify's webhook docs:

- Each successful webhook gets a `X-Shopify-Webhook-Id` (UUID). **Unique per delivery.** Use for dedup.
- HMAC signature in `X-Shopify-Hmac-Sha256` over the raw body with the app's secret.
- **At-least-once delivery.** Duplicates happen.
- **Out-of-order delivery.** Don't rely on sequence between topics.
- **Retry**: if our endpoint returns non-2xx or times out, Shopify retries up to **19 times over 48 hours** with exponential backoff.
- **Timeout**: Shopify waits ~5 seconds for our response.

Therefore every handler must:

1. Verify the HMAC.
2. Dedup by `X-Shopify-Webhook-Id`.
3. Respond 2xx fast — actual work goes to a job queue.
4. Be idempotent.

---

## 4. Common middleware pattern

Every handler is a Remix route under `app/routes/webhooks.<topic>.tsx`. They share the same entry pattern:

```typescript
// app/routes/webhooks.orders.paid.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { prisma } from "../lib/prisma.server";
import { enqueueJob } from "../lib/jobs.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. HMAC verification + shop resolution happen inside authenticate.webhook()
  const { topic, shop, payload, webhookId, admin } = await authenticate.webhook(request);

  // 2. Resolve our Shop row
  const shopRow = await prisma.shop.findUnique({ where: { shopDomain: shop } });
  if (!shopRow) return new Response("shop not installed", { status: 200 }); // 200 so Shopify stops retrying

  // 3. Dedup — atomic insert; if unique constraint fails, we've seen this delivery
  const event = await prisma.webhookEvent.upsert({
    where:  { webhookGid: webhookId },
    update: {},  // no-op on duplicate
    create: {
      shopId:      shopRow.id,
      topic,
      webhookGid:  webhookId,
      payloadHash: sha256(await request.clone().text()),
      status:      "pending",
    },
  });
  if (event.status === "processed") return new Response("duplicate", { status: 200 });

  // 4. Fast path: enqueue and return 200
  await enqueueJob({
    shopId:       shopRow.id,
    type:         `webhook:${topic}`,
    payload:      JSON.stringify({ webhookEventId: event.id, data: payload }),
  });

  return new Response(null, { status: 200 });
};
```

Key properties:

- HMAC check is done by `@shopify/shopify-app-remix`'s `authenticate.webhook()`. If it fails, it throws and returns 401 automatically.
- The route returns 200 in < 500 ms always. Work happens in the job worker.
- Dedup uses Postgres unique constraint on `WebhookEvent.webhookGid` — atomic and race-safe.
- Unknown shops return 200 (not 404) so Shopify doesn't keep retrying a webhook for a shop we never heard of (edge case: webhooks subscribed before install completed).

---

## 5. `orders/paid` — the core handler

### Job handler (runs async, not in the HTTP path)

```
handle_orders_paid(shopId, payload):
  1. Parse payload into OrderFields {
       orderGid, orderName,
       email, phone,
       customer { id, tags },
       discountCodes: [{ code, amount }],
       discountApplications: [{ title, code, ... }],
       shippingAddress: { address1, address2, city, zip, country_code },
       billingAddress:  same shape,
       browserIp,
       clientDetails: { browser_ip, ... },
     }

  2. Find matching protected offers:
       codesInOrder = uppercase(set of payload.discount_codes[].code)
       offers = ProtectedOffer.find({
         shopId, status: "active",
         codes: { some: { codeUpper: { in: codesInOrder } } }
       })
     If offers is empty → mark WebhookEvent processed, return. (Not our offer.)

  3. For each matching offer:
       shop = Shop.findUnique({ id: shopId })
       signals = normalize_signals(
         payload.email, payload.phone,
         payload.shippingAddress,
         payload.browserIp,
         shop.defaultCountryCode
       )

       hashes = compute_hashes(signals, shop.salt)
       minhashes = compute_minhashes(signals, shop.salt)

       // 3a. Insert the new redemption
       newRecord = RedemptionRecord.create({
         shopId, protectedOfferId: offer.id,
         orderGid: payload.admin_graphql_api_id,
         orderName: payload.name,
         codeUsed: matching_code,
         customerGid: payload.customer?.admin_graphql_api_id,

         emailCiphertext:    encrypt(signals.email_canonical, shop.encryptionKey),
         phoneCiphertext:    encrypt(signals.phone_e164, shop.encryptionKey),
         addressCiphertext:  encrypt(JSON.stringify(signals.address), shop.encryptionKey),
         ipCiphertext:       encrypt(payload.browserIp, shop.encryptionKey),

         phoneHash:           hashes.phone,
         emailCanonicalHash:  hashes.email_canonical,
         addressFullHash:     hashes.addr_full,
         ipHash24:            hashes.ip_24,

         emailMinhashSketch:  hexof(minhashes.email),
         addressMinhashSketch: hexof(minhashes.addr),
       })

       // 3b. Authoritative scoring using Prisma (§5 of scoring spec)
       { score, facts, recordIds } = score_post_order(signals, offer, ip, prisma, shop.salt)

       if score >= 10:
         risk_level = "HIGH"
       elif score >= 4:
         risk_level = "MEDIUM"
       else:
         risk_level = null

       // 3c. Create risk assessment + tag the order
       if risk_level:
         FlaggedOrder.create({ shopId, protectedOfferId: offer.id, orderGid, score, facts, riskLevel: risk_level, ... })

         await admin.graphql(ORDER_RISK_ASSESSMENT_CREATE, {
           orderId: payload.admin_graphql_api_id,
           riskLevel: risk_level,
           facts: facts.map(f => ({ description: f.message, sentiment: "NEGATIVE" })),
         })

         await admin.graphql(TAGS_ADD, {
           id: payload.admin_graphql_api_id,
           tags: ["promo-guard-flagged"],
         })

         if risk_level == "HIGH":
           await notify_merchant(shop, offer, orderName, facts)

       // 3d. Tag the customer (if logged in)
       if payload.customer?.admin_graphql_api_id:
         await admin.graphql(TAGS_ADD, {
           id: payload.customer.admin_graphql_api_id,
           tags: [`pg-redeemed-${offer.id}`],
         })

       // 3e. Append to shard metafields (queued — runs separately)
       await enqueueJob({ shopId, type: "shard_append", payload: { offerId: offer.id, recordId: newRecord.id } })

  4. Mark WebhookEvent as processed
```

### Sub-job `shard_append`

Runs with a per-offer mutex (only one shard update at a time per offer, to avoid write races on the shop metafield).

```
shard_append(offerId, recordId):
  record = RedemptionRecord.findUnique({ id: recordId })
  offer  = ProtectedOffer.findUnique({ id: offerId })

  for shardKey in ["phones", "emails_exact", "emails_minhash", "addrs_exact", "addrs_minhash"]:
    shard = ShardState.findUnique({ protectedOfferId: offerId, shardKey })
    current = shard?.metafieldGid ? read_metafield(offerId, shardKey) : empty_shard(shardKey)

    entry = match shardKey:
      "phones"          => record.phoneHash
      "emails_exact"    => record.emailCanonicalHash
      "emails_minhash"  => record.emailMinhashSketch
      "addrs_exact"     => [record.addressFullHash, record.addressHouseHash]  // two entries
      "addrs_minhash"   => record.addressMinhashSketch

    if entry is null: continue    // e.g., guest with no phone

    newShard = current.append(entry)
    while serialized_size(newShard) > 10_000 bytes:
      newShard.evict_oldest()      // also update ShardState.oldestRecordId pointer

    await admin.graphql(METAFIELDS_SET, {
      metafields: [{
        namespace: "$app",
        key: `pg_ledger_${offerId}_${shardKey}`,
        ownerId: shop_gid,
        type: "json",
        value: JSON.stringify(newShard),
      }]
    })

    ShardState.update({ protectedOfferId: offerId, shardKey }, {
      byteSize: serialized_size(newShard),
      entryCount: newShard.count(),
      oldestRecordId, newestRecordId,
      lastRebuiltAt: now,
      version: shard.version + 1,
    })
```

The mutex prevents two concurrent `orders/paid` events on the same offer from trampling each other's shard writes. Use Prisma's optimistic locking (increment version, retry on conflict) or a simple advisory lock per offer.

---

## 6. `app/uninstalled`

Fires when the merchant uninstalls the app. Shopify continues to deliver `shop/redact` 48 hours later. Our handler:

```
handle_app_uninstalled(shopId):
  // Immediate:
  Shop.update({ id: shopId }, { uninstalledAt: now })
  Session.deleteMany({ shop: shopDomain })          // revoke offline token
  Job.updateMany({ shopId, status: "pending" }, { status: "cancelled" })
  // Do NOT delete protected offers or ledger data. Merchant may reinstall within 48 hours.

  // The actual data deletion waits for shop/redact.
```

Optional: also deactivate Shopify Functions and discount codes tied to this shop — we can't, since the shop uninstalled our app and we no longer have a valid token. If the merchant reinstalls, we'd re-authenticate and re-deploy.

---

## 7. Compliance topics

### `customers/data_request`

> "Customers can request their data from a store owner. When this happens, Shopify invokes this webhook. A store owner / merchant is expected to provide this data to the customer directly."

Expected delivery: within 30 days. Payload includes `customer.id`, `customer.email`, `orders_requested[]`, `data_request.id`.

```
handle_customers_data_request(shopId, payload):
  customerGid = payload.customer.id
  request = ComplianceRequest.create({
    shopId, topic: "customers/data_request",
    customerGid, payload: JSON.stringify(payload),
    status: "pending",
  })

  // Generate export asynchronously
  enqueueJob({ shopId, type: "compliance_data_export", payload: { requestId: request.id } })

// Worker:
compliance_data_export(requestId):
  request = ComplianceRequest.findUnique({ id: requestId })
  records = RedemptionRecord.findMany({ customerGid: request.customerGid, shopId: request.shopId })
  decrypted = records.map(r => decrypt_pii(r, shop.encryptionKey))

  // Email or API-upload the export to the merchant's configured endpoint
  send_to_merchant({
    customerId: request.customerGid,
    data: decrypted,
  })

  request.update({ status: "completed", completedAt: now })
```

If the merchant has no configured endpoint, we email the shop owner with a download link valid 7 days.

### `customers/redact`

> "A customer wants their data deleted."

Expected delivery: 10 days after a customer requests redaction, assuming they've had no orders in the last 6 months.

```
handle_customers_redact(shopId, payload):
  customerGid = payload.customer.id
  request = ComplianceRequest.create({
    shopId, topic: "customers/redact", customerGid,
    payload: JSON.stringify(payload), status: "pending",
  })

  enqueueJob({ shopId, type: "compliance_customer_redact", payload: { customerGid, shopId, requestId: request.id } })

// Worker:
compliance_customer_redact(customerGid, shopId, requestId):
  records = RedemptionRecord.findMany({ customerGid, shopId })
  for r in records:
    r.update({
      emailCiphertext: null, phoneCiphertext: null,
      addressCiphertext: null, ipCiphertext: null,
      phoneHash: null, emailCanonicalHash: null,
      addressFullHash: null, ipHash24: null,
      emailMinhashSketch: null, addressMinhashSketch: null,
    })
    // We keep the row (for FlaggedOrder referential integrity) but remove all PII and all hashes

  // Rebuild shard metafields without the redacted entries
  for offerId in distinct(records.protectedOfferId):
    enqueueJob({ shopId, type: "shard_rebuild", payload: { offerId } })

  // Remove customer tag we added
  await admin.graphql(TAGS_REMOVE, {
    id: customerGid,
    tags: affectedOffers.map(o => `pg-redeemed-${o.id}`),
  })

  ComplianceRequest.update({ id: requestId }, { status: "completed", completedAt: now })
```

### `shop/redact`

> "48 hours after a store owner uninstalls your app, Shopify invokes this webhook."

Full shop purge.

```
handle_shop_redact(shopId, payload):
  request = ComplianceRequest.create({ shopId, topic: "shop/redact", payload, status: "pending" })

  enqueueJob({ shopId, type: "compliance_shop_redact", payload: { shopId, requestId: request.id } })

// Worker (can run > 5s; we already returned 200):
compliance_shop_redact(shopId, requestId):
  // Cascade deletes via Prisma onDelete: Cascade everywhere
  Shop.delete({ id: shopId })

  // Our Shop row deletion cascades to:
  //   ProtectedOffer → ProtectedCode, RedemptionRecord, FlaggedOrder, ShardState
  //   Job, WebhookEvent, AuditLog, ComplianceRequest

  // Can't delete Shopify-side metafields because we have no valid session after uninstall.
  // They're owned by our app — Shopify garbage-collects app-owned metafields 48 hours after uninstall.

  ComplianceRequest.update({ id: requestId }, { status: "completed", completedAt: now })
```

Note: we delete the `ComplianceRequest` row itself via the cascade. That's fine — Shopify's compliance audit only cares that we responded 200 to the webhook and that the shop's data no longer exists in our systems.

---

## 8. Error handling

### During HTTP receipt

- **HMAC invalid** → 401 (no retry from Shopify for this topic; likely a bad actor)
- **Body can't be parsed as JSON** → 400 (Shopify retries, but body won't change — we need to fix the handler)
- **Dedup insert fails due to unknown error** → 500 (Shopify retries)
- **Dedup insert succeeds, enqueue fails** → 500 (Shopify retries; the duplicate check catches it next time)
- **Everything succeeds** → 200

### During async processing

Every job has `attempts` counter. On failure:

```
catch (error):
  job.update({
    status: "failed",
    error: error.stack || error.message,
    attempts: job.attempts + 1,
  })

  if job.attempts < 5:
    // Exponential backoff retry
    enqueueJob(job.payload, { delay: 2^job.attempts * 30s, type: job.type })
  else:
    // Dead letter — alert on-call, leave row for debugging
    sendAlert(`Job ${job.id} failed 5 times`, error)
```

### Dead-letter monitoring

A scheduled job runs every 10 minutes:

```
alert_on_dead_letters():
  failed = Job.findMany({ status: "failed", attempts: { gte: 5 }, alertSent: false })
  for j in failed:
    sendAlert(j)
    j.update({ alertSent: true })
```

---

## 9. Rate limiting

Shopify GraphQL Admin API calls from webhook handlers count against the shop's bucket. Operations we make per `orders/paid` event:

| Operation | Calls | Cost (points) |
|---|---|---|
| `orderRiskAssessmentCreate` | 0 or 1 | ~10 |
| `tagsAdd` (order) | 0 or 1 | ~10 |
| `tagsAdd` (customer) | 0 or 1 | ~10 |
| `metafieldsSet` (5 shards) | 1 (batched) | ~10 |

Total: ~40 points per paid order at worst. Standard bucket leak is 50 points/second. Sustained: we can handle ~1 paid order/second per shop without hitting the ceiling. For spikes we batch shard metafield writes and rely on retry-with-backoff on 429s.

---

## 10. Testing

### Local

```bash
# Start dev server
shopify app dev

# Trigger a test webhook
shopify app webhook trigger --topic orders/paid --delivery-method http --address https://<tunnel>/webhooks/orders/paid
```

Needs a mock order payload with: `discount_codes: [{ code: "WELCOME10" }]`, an `email`, `shipping_address`, and `customer`.

### Tests to write

| Test | What it verifies |
|---|---|
| Invalid HMAC → 401 | Shopify-side auth working |
| Duplicate `webhookGid` → 200 silently | Dedup |
| `orders/paid` with no matching code → no DB writes, no admin calls | Early exit |
| `orders/paid` with matching code + new buyer → 1 RedemptionRecord, no FlaggedOrder | Score = 0 path |
| `orders/paid` with matching code + prior-match buyer → RedemptionRecord + FlaggedOrder + risk assessment | Full path |
| `orders/paid` where admin API returns 429 → job retries with backoff | Rate limit handling |
| `customers/redact` → PII nulled, tags removed, shards rebuilt | Compliance |
| `shop/redact` → cascade delete works, no orphans | Compliance |
| `app/uninstalled` + reinstall within 48 hours → data still present, `uninstalledAt` cleared | Reinstall grace |

---

## 11. What the handlers do NOT do

| Not here | Where instead |
|---|---|
| Scoring at checkout | Validation / Discount Functions (Rust) |
| Sharding logic | `shard_append` / `shard_rebuild` jobs |
| UI state updates | Admin UI Remix routes + React Query polling |
| Customer notification | Out of scope for MVP |
| Retries of Shopify webhooks | Shopify does this for us |

---

## 12. File layout

```
app/
  routes/
    webhooks.orders.paid.tsx
    webhooks.app.uninstalled.tsx
    webhooks.customers.data_request.tsx
    webhooks.customers.redact.tsx
    webhooks.shop.redact.tsx
  lib/
    webhook-auth.server.ts         ← wraps authenticate.webhook, dedup logic
    jobs.server.ts                  ← enqueueJob, a minimal queue backed by Job table
    crypto.server.ts                ← encrypt/decrypt helpers (shop DEK)
    admin-graphql.server.ts         ← helpers for orderRiskAssessmentCreate, tagsAdd, metafieldsSet
  jobs/
    handle-orders-paid.ts           ← the big worker
    shard-append.ts
    shard-rebuild.ts
    compliance-data-export.ts
    compliance-customer-redact.ts
    compliance-shop-redact.ts
    alert-dead-letters.ts           ← cron
  workers/
    worker.ts                       ← the job runner entrypoint (run in a separate process)
```

The worker runs as a separate Node process (`npm run worker`), polling `Job` rows where `status = 'pending'` ordered by `createdAt`. Simple, no external queue dependency. For production scale we'd swap to BullMQ/Redis; for MVP the Job-table queue is fine.

---

## 13. Open questions to confirm during implementation

| # | Question | How to confirm |
|---|---|---|
| 1 | Does `authenticate.webhook()` in `@shopify/shopify-app-remix` automatically return 401 on HMAC mismatch, or do we need to handle that? | Read lib source + test with a tampered body |
| 2 | Does `orders/paid` fire for orders paid via Shop Pay Installments (deferred payment)? | Test on a dev store |
| 3 | Does `orders/paid` include `browser_ip` when the order was placed via POS or Draft Order? | Test payloads; fallback: no IP = no IP-based flag |
| 4 | Does `tagsAdd` on a customer via Admin API append or replace? | Verify (expect append; docs confirm) |
| 5 | Does `metafieldsSet` support batching multiple keys in one call? | Expect yes, via `metafields` array input |

All five are cheap to verify during implementation.
