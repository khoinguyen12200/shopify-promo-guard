# Promo Guard — Scoring Algorithm Spec

How raw signals become a numeric risk score and a decision.

This is the second of three shared-contract docs (normalization → scoring → function input query). Both the Rust Function and the Node post-order worker implement this algorithm. Their outputs must agree on same inputs (post-order has more inputs available; see §5).

---

## 1. Goal

Given a cart (or an order) and a protected offer, produce:

- **score**: an integer in `[0, ~40]`
- **decision**: `ALLOW`, `MEDIUM`, or `HIGH`
- **facts**: a list of human-readable reasons, one per matched signal

The decision drives behaviour per context:

| Context | Score ≥ 10 (HIGH) | Score 4–9 (MEDIUM) | Score < 4 (ALLOW) |
|---|---|---|---|
| Validation Function (checkout) | `validationAdd` error | allow checkout | allow checkout |
| Post-order worker (`orders/paid`) | create HIGH `riskAssessment`, tag, notify | create MEDIUM `riskAssessment`, tag | no action |

Thresholds `4` and `10` are constants; see §3.

---

## 2. Inputs

### At checkout (Function)

```
BuyerSignals {
  email_canonical:        String | null
  email_trigrams:         Set<trigram>
  phone_e164:             String | null
  address_full_key:       String | null   (from addressKeys.full)
  address_house_key:      String | null   (from addressKeys.house)
  address_trigrams:       Set<trigram>
  customer_redeemed_tag:  Bool             (from cart.customer.hasAnyTag)
  cart_has_guarded_code:  Bool             (from cart.discountCodes ∩ offer.codes)
}

LedgerShards (read from shop metafields, normalized-version-1):
  phones:          Set<u32 hash>
  emails_exact:    Set<u32 hash>
  emails_minhash:  [Sketch[4]]    (list of sketches, one per ledger entry in the shard)
  addrs_exact:     Set<u32 hash>
  addrs_minhash:   [Sketch[4]]
```

### At post-order (Node worker)

All of the above **plus**:

```
ip_v4_24_key: String | null
ip_v6_48_key: String | null
```

Plus access to the full `RedemptionRecord` rows in Prisma (not just the recent shard), so matches can be attributed to specific prior orders.

---

## 3. Constants

```
THRESHOLD_MEDIUM = 4
THRESHOLD_HIGH   = 10

WEIGHTS = {
  phone_exact:              10,
  email_canonical_exact:    10,
  email_minhash_strong:      6,    // 2+ of 4 trigrams overlap (sim >= 0.5)
  email_minhash_weak:        4,    // 1 of 4 trigrams overlap (sim >= 0.25)
  address_full_exact:       10,
  address_house_exact:       8,
  address_minhash_strong:    6,    // 2+ of 4 trigrams overlap
  address_minhash_weak:      4,
  customer_tag:             10,
  ip_v4_24:                  2,    // post-order only
  ip_v6_48:                  2,    // post-order only
}

VERSION = 1
```

All values are constants for MVP. They live in `src/lib/scoring-constants.ts` (Node) and `shared-lib/src/scoring_constants.rs` (Rust), generated from a single JSON source so drift is impossible.

---

## 4. Per-signal rules

### 4.1 Phone

```
if phone_e164 is null → skip
h = hash_for_lookup("phone", phone_e164, shop_salt)
if h ∈ shards.phones → fact "Phone matches a prior redemption" weight 10
```

### 4.2 Email canonical

```
if email_canonical is null → skip
h = hash_for_lookup("email_canonical", email_canonical, shop_salt)
if h ∈ shards.emails_exact → fact "Email matches a prior redemption" weight 10
```

### 4.3 Email MinHash (fuzzy)

Skip if phone 4.2 already matched — exact beats fuzzy; don't double-count.

```
incoming_sketch = minhash_sketch(email_trigrams, "email_trigram", shop_salt)

best_overlap = 0
best_record_idx = -1
for each sketch in shards.emails_minhash:
  overlap = jaccard_count(incoming_sketch, sketch)      // 0..4
  if overlap > best_overlap:
    best_overlap = overlap
    best_record_idx = idx

if best_overlap >= 2 → fact "Similar email to a prior redemption" weight 6
else if best_overlap >= 1 → fact "Loose email similarity to a prior redemption" weight 4
```

### 4.4 Address full

```
if address_full_key is null → skip
h = hash_for_lookup("addr_full", address_full_key, shop_salt)
if h ∈ shards.addrs_exact → fact "Exact address matches a prior redemption" weight 10
```

### 4.5 Address house (unit stripped)

Skip if 4.4 already matched.

```
h = hash_for_lookup("addr_house", address_house_key, shop_salt)
// address_house_key is in its own hash space (tag differs), so we reuse the same
// addrs_exact shard: the shard stores BOTH full and house hashes (with different tags)
if h ∈ shards.addrs_exact → fact "Same building, different unit as a prior redemption" weight 8
```

> **Shard detail**: `addrs_exact` contains two hashes per ledger record — one with tag `addr_full`, one with tag `addr_house`. The tag is embedded in the hash input (see normalization spec §7), so they can safely coexist in one Set without collision risk.

### 4.6 Address MinHash (fuzzy)

Skip if 4.4 or 4.5 already matched.

```
incoming_sketch = minhash_sketch(address_trigrams, "addr_trigram", shop_salt)

best_overlap = max over shards.addrs_minhash of jaccard_count(incoming_sketch, sketch)

if best_overlap >= 2 → fact "Similar address to a prior redemption" weight 6
else if best_overlap >= 1 → fact "Loose address similarity" weight 4
```

### 4.7 Customer tag

```
if customer_redeemed_tag is true → fact "Customer account already redeemed this offer" weight 10
```

### 4.8 IP (post-order only)

```
if ip_v4_24_key is not null:
  h = hash_for_lookup("ip_v4_24", ip_v4_24_key, shop_salt)
  query Prisma: any RedemptionRecord with ipHash24 = h for this offer?
  if yes → fact "Residential IP matches a prior redemption" weight 2

if ip_v6_48_key is not null:
  h = hash_for_lookup("ip_v6_48", ip_v6_48_key, shop_salt)
  same as above
  if yes → fact "IP /48 matches a prior redemption" weight 2
```

---

## 5. Composition — how per-signal matches combine

Two modes, differing only in input:

### 5.1 Checkout mode (Function)

Per-signal membership, no per-record attribution:

```
def score_at_checkout(signals, shards, shop_salt) → (score, facts):
  if not signals.cart_has_guarded_code:
    return (0, [])                     // fast skip: not our offer's code
  facts = []
  score = 0
  score += try_rule_4_1(signals, shards) → append fact if matched
  score += try_rule_4_2_or_4_3(signals, shards)
  score += try_rule_4_4_or_4_5_or_4_6(signals, shards)
  score += try_rule_4_7(signals)
  return (score, facts)
```

**Why "or" across 4.2/4.3 and 4.4/4.5/4.6**: only the **strongest tier** of each signal family counts. Exact email or fuzzy email — never both. Exact full address, house match, or fuzzy address — exactly one.

Per signal family, strongest first:
- `email_canonical_exact` > `email_minhash_strong` > `email_minhash_weak` > nothing
- `address_full_exact` > `address_house_exact` > `address_minhash_strong` > `address_minhash_weak` > nothing

### 5.2 Post-order mode (Node worker)

Per-record max scoring:

```
def score_post_order(signals, offer, prisma, shop_salt) → (score, facts, winning_records):
  candidates = prisma.redemptionRecords.find({
    protectedOfferId: offer.id,
    OR: [
      { phoneHash: hash("phone", signals.phone) },
      { emailCanonicalHash: hash("email_canonical", signals.email_canonical) },
      { addressFullHash: hash("addr_full", signals.address_full_key) },
      { ipHash24: hash("ip_v4_24", signals.ip_v4_24_key) },
    ]
    OR (include MinHash candidates — see below)
  })

  // MinHash candidates: for each prior record, compute Jaccard with incoming.
  // For scale, limit to last 10,000 records per offer; authoritative scoring
  // never needs the whole history (attackers target recent campaigns).

  best = { score: 0, facts: [], record_ids: [] }
  for record in candidates:
    per_record_score = 0
    per_record_facts = []
    per_record_score += evaluate_rule_4_1(signals, record)   // phone
    per_record_score += evaluate_rule_4_2_or_4_3(signals, record)
    per_record_score += evaluate_rule_4_4_or_4_5_or_4_6(signals, record)
    per_record_score += evaluate_rule_4_7(signals, record)
    per_record_score += evaluate_rule_4_8(signals, record)   // IP, post-order only
    if per_record_score > best.score:
      best = { score: per_record_score, facts: per_record_facts, record_ids: [record.id] }
    elif per_record_score == best.score and per_record_score > 0:
      best.record_ids.append(record.id)
      best.facts = merge_facts(best.facts, per_record_facts)

  return best
```

**Semantics**: `score_post_order` returns the **max score vs. any single prior record** — "is there at least one prior redemption this buyer closely matches?"

This is more conservative (less prone to false positives) than checkout's per-signal membership. Post-order is authoritative; it overrides checkout's decision for the risk assessment.

---

## 6. Decision mapping

```
def decide(score) → decision:
  if score >= THRESHOLD_HIGH: return "HIGH"
  if score >= THRESHOLD_MEDIUM: return "MEDIUM"
  return "ALLOW"
```

### At checkout

| Decision | Validation Function |
|---|---|
| HIGH | emit `validationAdd` error with message (block at checkout) |
| MEDIUM | **allow checkout** |
| ALLOW | allow |

Yes — at checkout MEDIUM does nothing. Only HIGH blocks. Medium matches are weak enough that blocking would produce more false positives than the protection is worth. They'll be flagged post-order instead.

### At post-order

| Decision | Action |
|---|---|
| HIGH | `orderRiskAssessmentCreate(riskLevel: HIGH)` + tag `promo-guard-flagged` + notify merchant |
| MEDIUM | `orderRiskAssessmentCreate(riskLevel: MEDIUM)` + tag `promo-guard-flagged` |
| ALLOW | no action |

---

## 7. Fact messages (for the native Risk section)

Messages are short, concrete, and end with "on order #N" when attribution is known (post-order). Checkout messages omit the order number (not available in-Function).

| Rule | Post-order fact | Checkout fact |
|---|---|---|
| 4.1 Phone exact | `Phone matches prior redemption on order #1234` | `Phone matches a prior redemption` |
| 4.2 Email canonical | `Email matches prior redemption on order #1234` | `Email matches a prior redemption` |
| 4.3 Email MinHash strong | `Similar email to prior redemption on order #1234 (khoi.nguyen@gmail.com ↔ testerkhoi@gmail.com)` | `Similar email to a prior redemption` |
| 4.3 Email MinHash weak | `Loose email similarity to prior redemption on order #1234` | `Loose email similarity` |
| 4.4 Address full | `Exact address matches prior redemption on order #1234` | `Address matches a prior redemption` |
| 4.5 Address house | `Same building, different unit as prior redemption on order #1234` | `Address (same building) matches` |
| 4.6 Address MinHash | `Similar address to prior redemption on order #1234` | `Similar address to a prior redemption` |
| 4.7 Customer tag | `Customer already redeemed this offer` | (same) |
| 4.8 IP /24 | `Residential IP matches prior redemption on order #1234` | (N/A at checkout) |
| 4.8 IP /48 | `IP /48 matches prior redemption on order #1234` | (N/A) |

Post-order includes the raw similar-email comparison only when it's unambiguous (level 2 protected-customer-data approval granted); otherwise omit the parenthetical.

---

## 8. Edge cases

| Situation | Behavior |
|---|---|
| Signal is `null` (e.g., guest with no phone) | Skip that signal. Don't error. |
| Cart has no discount codes | Function returns `ALLOW` instantly (no ledger read). Saves input-query cost. |
| Cart has a code that isn't in our offer's group | Same — `ALLOW`. The function is scoped to its specific offer. |
| Multiple offers active, cart has code from offer A | Only offer A's function runs; it reads offer A's shards. |
| Shard metafield missing (app just installed, cold-start running) | Treat as empty set. Allow everything. Log a debug line. |
| Incoming signal matches across multiple ledger records | Checkout: contributes once (per-signal membership). Post-order: picks the single record that maximizes the combined score across signals. |
| Tie in post-order (two records with identical score) | Sort by record.id ascending, take first. Append all tied record_ids to the risk assessment facts. |
| Shard version mismatch (`v: 1` stored, code expects `v: 2`) | Function rejects with an internal error; platform-side retry with a rebuild-then-retry worker. Fail-open: if rebuild hasn't happened, treat shard as empty. |
| Score is exactly 4 or exactly 10 | Threshold is `>=`, so 4 → MEDIUM, 10 → HIGH. |

---

## 9. Worked examples

Let `shop_salt = "abc123"`. `offer = "welcome_program"`.

Prior ledger has one record: `RedemptionRecord A` with
- phone `+84901234567`
- email `khoi.nguyen@gmail.com` → canonical `khoinguyen@gmail.com`
- address `123 Main St, 94102, US` → full_key `123 main st||94102|US`, house_key `main st|94102|US`

### Case 1 — same person, same phone, different email, same address

Incoming:
- phone `+84901234567`
- email `testerkhoi@gmail.com` (canonical: `testerkhoi@gmail.com`)
- address `123 Main St, 94102, US`

Evaluation:
- 4.1 phone exact match → +10
- 4.2 email canonical: no match (`testerkhoi` ≠ `khoinguyen`). Skip to 4.3.
- 4.3 email MinHash: incoming trigrams `{tes, est, ste, ter, erk, rkh, kho, hoi}`, A's trigrams `{kho, hoi, oin, ing, ngu, guy, uye, yen}`. Jaccard overlap count (bottom-4) likely 1 (both contain `kho`/`hoi`, but bottom-K gets weird; assume overlap = 1). → +4
- 4.4 address full: match → +10
- 4.7: logged in? Depends. Assume guest → 0

**Score = 24 → HIGH → block at checkout, flag HIGH post-order.**

### Case 2 — same address, completely different email and phone

Incoming:
- phone `+84999999999`
- email `randomperson@yahoo.com`
- address `123 Main St, 94102, US`

Evaluation:
- 4.1 no → 0
- 4.2 no → 0; 4.3 no shared trigrams → 0
- 4.4 address full match → +10
- 4.7 no → 0

**Score = 10 → HIGH → block.**

Is this a false positive risk? If a household member legitimately places a first order, yes — they'd be blocked. Addressed by:
- Address match alone = weight 10, right at the threshold.
- Merchant can configure per-offer: "require at least 2 signals" in a future iteration. Out of scope for MVP.
- The customer can try a slightly different address line (unit), which would drop the match to `address_minhash_strong` = 6 (MEDIUM, allowed at checkout).

### Case 3 — similar email only

Incoming:
- phone null (guest)
- email `khoistarter@gmail.com`
- address completely different

Evaluation:
- 4.1 null → skip
- 4.2 no exact; 4.3 MinHash overlap 1 (`kho`) → +4
- 4.4–4.6 no match → 0

**Score = 4 → MEDIUM. Allowed at checkout. Flagged post-order for merchant review.**

### Case 4 — IP alone (post-order only)

Incoming (guest, new identity):
- phone `+84999999999`
- email `someone@example.com`
- address completely different
- IP `/24` matches prior record A

Evaluation post-order:
- nothing except IP matches → +2

**Score = 2 → ALLOW.** No flag. Shared-network collisions don't pollute the merchant's admin.

---

## 10. Pseudocode summary

### Checkout (Rust, pseudocode)

```rust
pub fn score_checkout(signals: &BuyerSignals, shards: &Shards, salt: &[u8]) -> (u32, Vec<Fact>) {
    if !signals.cart_has_guarded_code { return (0, vec![]); }
    let mut score = 0;
    let mut facts = vec![];

    if let Some(phone) = &signals.phone_e164 {
        let h = hash_for_lookup(PHONE_TAG, phone, salt);
        if shards.phones.contains(&h) {
            score += W_PHONE_EXACT;
            facts.push(fact("Phone matches a prior redemption"));
        }
    }

    // email: exact OR fuzzy, not both
    let email_added = if let Some(email) = &signals.email_canonical {
        let h = hash_for_lookup(EMAIL_CANONICAL_TAG, email, salt);
        if shards.emails_exact.contains(&h) {
            score += W_EMAIL_CANONICAL;
            facts.push(fact("Email matches a prior redemption"));
            true
        } else { false }
    } else { false };
    if !email_added {
        let incoming = minhash_sketch(&signals.email_trigrams, EMAIL_TRIGRAM_TAG, salt);
        let best = shards.emails_minhash.iter().map(|s| jaccard_count(&incoming, s)).max().unwrap_or(0);
        match best {
            2..=4 => { score += W_EMAIL_MH_STRONG; facts.push(fact("Similar email to a prior redemption")); }
            1     => { score += W_EMAIL_MH_WEAK;   facts.push(fact("Loose email similarity")); }
            _ => {}
        }
    }

    // address: full OR house OR fuzzy, pick one
    // ... analogous structure ...

    if signals.customer_redeemed_tag {
        score += W_CUSTOMER_TAG;
        facts.push(fact("Customer already redeemed this offer"));
    }

    (score, facts)
}
```

### Post-order (TypeScript, pseudocode)

```ts
async function scorePostOrder(
  signals: BuyerSignals,
  offer: ProtectedOffer,
  ip: IpSignals,
  prisma: PrismaClient,
  salt: Buffer
): Promise<{ score: number; facts: Fact[]; recordIds: string[] }> {
  const candidates = await prisma.redemptionRecord.findMany({
    where: {
      protectedOfferId: offer.id,
      OR: [
        signals.phone && { phoneHash: hashForLookup(PHONE_TAG, signals.phone, salt) },
        signals.emailCanonical && { emailCanonicalHash: hashForLookup(EMAIL_CANONICAL_TAG, signals.emailCanonical, salt) },
        signals.addressFullKey && { addressFullHash: hashForLookup(ADDR_FULL_TAG, signals.addressFullKey, salt) },
        ip.v4_24 && { ipHash24: hashForLookup(IP24_TAG, ip.v4_24, salt) },
      ].filter(Boolean),
    },
    take: 5000,
  });

  // Also pull MinHash candidates from the last N records
  const recent = await prisma.redemptionRecord.findMany({
    where: { protectedOfferId: offer.id },
    orderBy: { createdAt: 'desc' },
    take: 10_000,
  });
  const allCandidates = dedupeById([...candidates, ...recent]);

  const incomingEmailSketch = minhashSketch(signals.emailTrigrams, EMAIL_TRIGRAM_TAG, salt);
  const incomingAddrSketch  = minhashSketch(signals.addressTrigrams, ADDR_TRIGRAM_TAG, salt);

  let best = { score: 0, facts: [] as Fact[], recordIds: [] as string[] };
  for (const r of allCandidates) {
    const { score, facts } = scoreAgainstRecord(signals, ip, r, incomingEmailSketch, incomingAddrSketch, salt);
    if (score > best.score) best = { score, facts, recordIds: [r.id] };
    else if (score === best.score && score > 0) best.recordIds.push(r.id);
  }
  return best;
}
```

Where `scoreAgainstRecord` applies rules 4.1–4.8 one by one, choosing the highest-tier match per signal family per record.

---

## 11. Performance budget

### Checkout (Rust Function)

| Phase | Instruction budget (out of 11 M total) |
|---|---|
| Parse 5 shards from JSON | ~2 M |
| Compute 2 MinHash sketches (incoming email + address) | ~0.5 M |
| Set-lookup: 3 exact hashes × 1 set each | ~0.3 M |
| Scan MinHash sketches (up to 625 entries × 4 comparisons × 2 signals) | ~5 M |
| Build facts + serialize output | ~0.5 M |
| **Budget used** | **~8.3 M / 11 M** (75%) |

Comfortable. If we hit limits, the first optimization is to short-circuit once score reaches 10 (can't go higher than highest-tier decision needs).

### Post-order (Node worker)

No strict budget, but aim for <500 ms per order:
- 2 Prisma queries, indexed
- 10k MinHash comparisons in Node: ~50 ms
- Risk assessment mutation: ~200 ms

---

## 12. Versioning

Matches normalization spec §11. The `VERSION` constant ties this scoring spec to a particular shard format + hash family. Change means migration.

---

## 13. Non-goals

- **Per-offer scoring weights** — merchants can't configure weights in MVP. Ship defaults.
- **ML-based scoring** — deterministic rules only. No training data. No explainability problem.
- **Cross-offer score carryover** — each offer is scored independently. No "customer has medium risk on offer A, bump offer B's sensitivity."
- **Time decay** — a record from 2 years ago contributes the same weight as yesterday. Eviction handles recency at the shard layer (Function side); Prisma keeps full history for post-order. No exponential decay.
