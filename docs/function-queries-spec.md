# Promo Guard — Function Input Query Spec

> Block-only enforcement (silent_strip mode was removed). Only the
> Cart & Checkout Validation Function ships now — the Discount Function
> sections that used to live here have been deleted.


The exact GraphQL input query for the Cart & Checkout Validation Function, along with the output contract it must satisfy.

Both queries must stay under the hard Shopify limits:

| Limit | Value |
|---|---|
| Function input (total bytes) | 128,000 |
| Individual metafield value returned | 10,000 bytes |
| Query cost (computed per the table below) | 30 |
| Query source length (excluding comments) | 3,000 bytes |
| List variable element count | ≤ 100 |

### Query cost table (from Shopify docs — current as of 2026-01 schema)

| Field | Cost |
|---|---|
| `__typename` | 0 |
| Any field returning a `Metafield` object (e.g. `shop.metafield(...)`) | 3 |
| Any field on a `Metafield` object (`value`, `jsonValue`, `type`) | 0 |
| `hasAnyTag` / `hasTags` | 3 |
| Any field on a `HasTagResponse` object (`hasTag`) | 0 |
| `inAnyCollection` / `inCollections` | 3 |
| Any field on a `CollectionMembership` object (`isMember`) | 0 |
| Any other leaf field (scalar, like `email`, `address1`, `id`) | 1 |

---

## Verified Shopify schema facts (checked via toolkit)

| Claim | Status |
|---|---|
| `shop { metafield(namespace, key) { value } }` works inside Function input | ✅ verified (Discount Allocator example) |
| `shop { metafield(...) }` at the top level of Validation Function input | ✅ (top-level `shop`, `presentmentCurrencyRate` are standard) |
| `cart.buyerIdentity.{email, phone}` — requires protected customer data level 2 | ✅ verified |
| `cart.buyerIdentity.customer.hasAnyTag(tags: [...])` | ✅ verified |
| `cart.deliveryGroups.deliveryAddress.{address1, address2, city, zip, countryCode, phone}` | ✅ verified — `phone`, `address1`, etc. require level 2 |
| `cart.attribute(key: ...) { value }` inside Validation Function | ✅ verified |
| `cart.discountCodes { code, applicable }` inside **Validation** Function input | ❌ confirmed absent from the `cart_checkout_validation` schema. Adopted **Plan C** (see §9). |
| `orderRiskAssessmentCreate` — risk levels `LOW`, `MEDIUM`, `HIGH`, `facts[]`, `provider{title}` | ✅ verified |

---

## 1. Configuration metafield (per protected offer)

Each protected offer has a single JSON metafield that the Function reads as config. It contains:

- the codes the offer guards (so the Validation Function knows whether to act)
- the shop salt (for in-Rust hashing)
- version marker
- per-offer thresholds (hard-coded in MVP, just echoes `THRESHOLD_HIGH = 10`)

### Storage

Namespace: `$app` (reserved app-owned). Key: `pg_offer_config_<offerId>`. Type: `json`.

### Shape

```json
{
  "v": 1,
  "offer_id": "clx123abc",
  "codes_upper": ["WELCOME10", "WELCOME15", "NEWBIE"],
  "salt_hex": "7465737473616c74...",
  "default_country_cc": "+84",
  "tag": "pg-redeemed-clx123abc",
  "threshold_high": 10
}
```

Size: well under 10 KB even with dozens of codes.

The Function reads this via `shop.metafield(namespace: "$app", key: "pg_offer_config_<offerId>")` — but since `<offerId>` is baked into the deployed Function's configuration (not dynamic), we pass the key via **input query variables** sourced from the Function's own `extensions.input.variables` metafield per Shopify's variables doc. Practical shortcut: hard-code the metafield key per deployed Function instance (one Function deployment per protected offer).

---

## 2. Shard metafields (per protected offer)

Five separate metafields, one per signal shard, each ≤ 10 KB. Keys:

```
$app / pg_ledger_<offerId>_phones           JSON: {"v":1,"hashes":["a1b2c3d4", ...]}
$app / pg_ledger_<offerId>_emails_exact     JSON: {"v":1,"hashes":["..."]}
$app / pg_ledger_<offerId>_emails_minhash   JSON: {"v":1,"sketches":["1a2b3c4d000000017fffffffffffffff", ...]}
$app / pg_ledger_<offerId>_addrs_exact      JSON: {"v":1,"hashes":["..."]}
$app / pg_ledger_<offerId>_addrs_minhash    JSON: {"v":1,"sketches":["..."]}
```

`hashes` are lowercase 8-char hex; `sketches` are 32-char hex (four u32s concatenated). See normalization spec §6.

---

## 3. Validation Function — input query

Target: `cart.validations.generate.run`. Output type: `CartValidationsGenerateRunResult`.

### Query (Rust flavour — the module is named `run`)

```graphql
query Input {
  cart {
    buyerIdentity {
      email
      phone
      customer {
        hasAnyTag(tags: ["__PG_TAG_PLACEHOLDER__"])
      }
    }

    deliveryGroups {
      deliveryAddress {
        address1
        address2
        city
        zip
        countryCode
      }
    }

    discountCodes {
      code
      applicable
    }
  }

  shop {
    config:          metafield(namespace: "$app", key: "pg_offer_config_OFFER_ID")        { value }
    phones:          metafield(namespace: "$app", key: "pg_ledger_OFFER_ID_phones")        { value }
    emailsExact:     metafield(namespace: "$app", key: "pg_ledger_OFFER_ID_emails_exact")  { value }
    emailsMinhash:   metafield(namespace: "$app", key: "pg_ledger_OFFER_ID_emails_minhash"){ value }
    addrsExact:      metafield(namespace: "$app", key: "pg_ledger_OFFER_ID_addrs_exact")   { value }
    addrsMinhash:    metafield(namespace: "$app", key: "pg_ledger_OFFER_ID_addrs_minhash") { value }
  }
}
```

Note: `OFFER_ID` and `__PG_TAG_PLACEHOLDER__` are substituted at Function deploy time by the app backend before writing the `.graphql` file. They are not GraphQL variables — they are string substitutions that produce a static query per offer.

### Cost calculation

| Item | Count | Per-item cost | Subtotal |
|---|---|---|---|
| Leaf scalars under `cart.buyerIdentity` (`email`, `phone`) | 2 | 1 | 2 |
| `hasAnyTag` | 1 | 3 | 3 |
| Leaf scalars under `deliveryAddress` | 5 | 1 | 5 |
| Leaf scalars under `discountCodes` | 2 | 1 | 2 |
| `shop.metafield(...)` calls | 6 | 3 | 18 |
| Fields on `Metafield` (`value`) | 6 | 0 | 0 |
| **Total** | | | **30** |

Exactly at the budget. Any additional field pushes us over. If we need headroom:

1. Drop `discountCodes.applicable` → save 1.
2. Drop `deliveryAddress.address2` → save 1 (we already do fuzzy match on the rest).
3. Combine `config` into `phones` metafield and parse accordingly → save 3 (one fewer metafield read). **Chosen for v1 if we need room.**

### Fallback if `cart.discountCodes` isn't in the Validation Function schema

Plan B: drop `discountCodes` from the query. The merchant must activate the Validation Function only for checkouts that use our offer, which Shopify's Checkout Rules doesn't support natively.

Plan C: use `cart.lines[].discountAllocations.discountApplication.title` (available in discount allocations) to reconstruct which code was applied. More expensive query-cost-wise.

Decision: **scaffold first, run `shopify app function schema --stdout`, confirm. If absent, switch to Plan C with a reduced metafield list (drop `emails_minhash` in favor of embedding it into the `emails_exact` shard's JSON, freeing one metafield slot).**

### Output shape (Rust)

```rust
Ok(schema::CartValidationsGenerateRunResult {
    operations: vec![
        schema::Operation::ValidationAdd(schema::ValidationAddOperation {
            errors: vec![
                schema::ValidationError {
                    message: "This offer has already been used.".to_string(),
                    target: "$.cart".to_string(),
                },
            ],
        }),
    ],
})
```

On `ALLOW`: return `operations: vec![schema::Operation::ValidationAdd(schema::ValidationAddOperation { errors: vec![] })]` — an empty errors list is the idiomatic "no problem" shape.

### Example input JSON (what Shopify passes to the Function)

```json
{
  "cart": {
    "buyerIdentity": {
      "email": "testerkhoi@gmail.com",
      "phone": "+84901234567",
      "customer": {
        "hasAnyTag": false
      }
    },
    "deliveryGroups": [
      {
        "deliveryAddress": {
          "address1": "125 Main St",
          "address2": null,
          "city": "San Francisco",
          "zip": "94102",
          "countryCode": "US"
        }
      }
    ],
    "discountCodes": [
      { "code": "WELCOME10", "applicable": true }
    ]
  },
  "shop": {
    "config":        { "value": "{\"v\":1,\"offer_id\":\"clx123abc\",\"codes_upper\":[\"WELCOME10\",\"WELCOME15\"],\"salt_hex\":\"...\",\"default_country_cc\":\"+84\",\"tag\":\"pg-redeemed-clx123abc\",\"threshold_high\":10}" },
    "phones":        { "value": "{\"v\":1,\"hashes\":[\"a1b2c3d4\",\"55667788\"]}" },
    "emailsExact":   { "value": "{\"v\":1,\"hashes\":[\"...\"]}" },
    "emailsMinhash": { "value": "{\"v\":1,\"sketches\":[\"1a2b3c4d000000017fffffffffffffff\"]}" },
    "addrsExact":    { "value": "{\"v\":1,\"hashes\":[\"...\"]}" },
    "addrsMinhash":  { "value": "{\"v\":1,\"sketches\":[\"...\"]}" }
  }
}
```

---

## 4. (removed)

The Discount Function used to live here. It was deleted along with `silent_strip` mode — block (validation function) is now the only enforcement path.

---

## 5. Keeping to the 128 KB total input budget

Each shard metafield: up to 10 KB actual value. Shop passes the full JSON string as `value` (a `String`). 5 shards × 10 KB = 50 KB of shard payload. Plus ~1 KB config. Plus the cart payload (lines, deliveryGroups, buyerIdentity). For typical carts this totals under 60 KB — well within 128 KB.

Large carts with 100+ lines push us toward the limit. Cart lines aren't in our query (we don't need them for scoring), so this is moot — the cart portion of our input is a handful of KB at most.

---

## 6. Shopify CLI commands used during development

Per the toolkit's guidance, Functions are scaffolded and built only via Shopify CLI:

```bash
# Scaffold the Validation Function extension
shopify app generate extension --template cart_checkout_validation --flavor rust --name promo-guard-validator

# Download the current schema (for checking cart.discountCodes availability)
shopify app function schema --stdout > schema.graphql

# Build
shopify app function build

# Run locally with a specific input JSON
shopify app function run --input=test-input.json --export=run

# Regenerate typegen after editing the .graphql
shopify app function typegen
```

No `shopify app deploy` until merchant testing is green.

---

## 7. File layout

```
extensions/
  promo-guard-validator/
    shopify.extension.toml
    src/
      main.rs                       ← pub mod run;  #[typegen("./schema.graphql")] ...
      run.rs                        ← scoring logic
      run.graphql                   ← the query from §3 above (OFFER_ID substituted)
      scoring.rs                    ← shared scoring fn (vendored from /shared-lib)
      normalize.rs                  ← shared normalization (vendored)
      hash.rs                       ← shared FNV + MinHash (vendored)
    Cargo.toml
    schema.graphql                  ← generated by `shopify app function schema`

```

Shared Rust library: `shared-lib/src/{normalize,hash,scoring,constants}.rs`. Copied into each extension during `shopify app function build` via a pre-build script (Cargo workspaces don't play perfectly with Shopify's function build flow).

---

## 8. `shopify.extension.toml` for each Function

### Validation Function

```toml
api_version = "2025-10"

[[extensions]]
name        = "Promo Guard Validator"
handle      = "promo-guard-validator"
type        = "function"
description = "Blocks checkout when identity signals match a prior welcome-offer redemption."

[[extensions.targeting]]
target       = "cart.validations.generate.run"
input_query  = "src/run.graphql"
export       = "run"

[extensions.build]
command = "cargo build --target=wasm32-wasip1 --release"
path    = "target/wasm32-wasip1/release/promo-guard-validator.wasm"
watch   = ["src/**/*.rs", "src/**/*.graphql"]

[access_scopes]
scopes = "read_customers"
```

---

## 9. Open questions confirmed during scaffolding (T24)

| # | Question | Resolution |
|---|---|---|
| 1 | Does `cart.discountCodes { code, applicable }` exist in the Cart and Checkout Validation Function schema? | **No.** Confirmed absent from the `cart_checkout_validation` schema at `api_version = 2025-10`. Adopted **Plan C** (see below). |
| 2 | Are `email`, `phone`, `address1`, `zip` nullable in the input schema? | **Yes — all nullable.** Typegen emits `Option<&String>` for every buyer + address leaf. `hasAnyTag` is non-null `&bool`. `cart()` and `shop()` return `&T` (not Option). `deliveryAddress` is `Option<&DeliveryAddress>`. |
| 3 | Does `shop.metafield(...)` resolve to null when the metafield doesn't exist yet? | **Yes — resolves to null**, not an error. The validator treats any absent / malformed shard as `Shard::default()` and fail-opens. |
| 4 | Are there per-target cost differences in the 30-budget? | Docs imply flat 30; confirmed at build time — typegen + build succeed with cost ≤ 30. |

### Plan C (adopted for v1)

Because `cart.discountCodes` is absent from the Validation Function input schema, we cannot gate scoring on "cart contains our offer's code" at Function time. Instead:

1. The app deploys **one Validation Function** per shop (not per offer). It reads a single shop-wide shard, so adding a new protected offer is pure data — no function redeploy required.
2. Activation is automatic — when a merchant creates their first protected offer the app calls `validationCreate(functionHandle: "promo-guard-validator", enable: true)`. Subsequent activate/deactivate flips are mirrored via `validationUpdate`. No manual Checkout Rules wiring required.
3. The shard is **per-offer-bucketed** under `namespace: "$app"`, `key: "shard_v2"`. The validator iterates each bucket, scores against that bucket's hashes, and emits a `ValidationError` for any offer whose score ≥ THRESHOLD_HIGH **AND** whose bucket has `mode: "block"`. Watch-mode offers never block — they're caught post-order via the orders/paid handler. Per-offer segmentation is required for correctness: a buyer who redeemed offer A's discount must still be able to redeem a different offer B for the first time.

Shard shape (v2):

```json
{
  "v": 2,
  "salt_hex": "deadbeef...",
  "default_country_cc": "+84",
  "offers": {
    "<protectedOfferId>": {
      "mode": "block",                                            // or "watch"
      "entry_ts":             [1700000001, ...],
      "phone_hashes":         ["a1b2c3d4", ...],
      "email_hashes":         ["..."],
      "address_full_hashes":  ["..."],
      "address_house_hashes": ["..."],
      "ip_hashes":            ["..."],
      "device_hashes":        ["..."],
      "email_sketches":       ["1a2b3c4d000000017fffffffffffffff", ...],
      "address_sketches":     ["..."]
    }
  }
}
```

All fields optional; the parser drops malformed hex entries per-row so a single bad value cannot take the shop offline. Eviction is global LRU — when serialized size exceeds the cap, the validator's writer picks the offer holding the globally-oldest entry and trims its arrays in lockstep.

### Plan C cost calculation

| Item | Count | Per-item cost | Subtotal |
|---|---|---|---|
| Leaf scalars under `cart.buyerIdentity` (`email`, `phone`) | 2 | 1 | 2 |
| `hasAnyTag` | 1 | 3 | 3 |
| Leaf scalars under `deliveryAddress` | 4 | 1 | 4 |
| `shop.metafield(...)` (single shard) | 1 | 3 | 3 |
| Field on `Metafield` (`jsonValue`) | 1 | 0 | 0 |
| **Total** | | | **12** |

18 points of headroom. MinHash sketch computation at checkout is explicitly skipped in v1 (the JS validator runs on Javy with a tight wasm budget — Javy's runtime baseline is ~80 KB); fuzzy matching is deferred to post-order scoring (scoring-spec §5.2).

---

## 10. Non-goals

- **Per-offer function deploys** — Plan C (§9) adopts a single shop-wide shard with per-offer buckets and one validation function per shop. The per-offer analytics split lives in Postgres (`RedemptionRecord.protectedOfferId`); per-offer enforcement decisions live in the bucket's `mode` field within the shard.
- **Discount-time enforcement (silent strip)** — we don't ship a Discount Function. Block (validation) is the only checkout-time enforcement; the discount-function context didn't have the signal coverage to detect abuse reliably.
