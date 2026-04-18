# Promo Guard — Normalization & Fingerprint Spec

The single source of truth for how raw buyer signals become hashes and MinHash sketches.

**This document is a contract.** The Node.js app backend and the Rust Shopify Function must produce **byte-identical output** for every operation defined here. A divergence means the Function misses matches the webhook found, or vice versa — silent correctness bugs with no error surface.

---

## Invariants

1. **Deterministic** — same input + same shop salt = same output, forever.
2. **Byte-identical across implementations** — Node `Buffer` and Rust `&[u8]` must hash to the same `u32`.
3. **UTF-8 throughout** — all string operations happen on UTF-8 bytes. Never on JS `string` length (which counts UTF-16 code units) or Rust `char` counts.
4. **No external crates in Rust** — the Function only depends on `shopify_function`. Every algorithm here has a from-scratch implementation.
5. **Per-shop salted** — the shop's `salt` is prepended to every hash input. No cross-shop hash correlation.
6. **Canonical hash representation**: 32-bit hashes are encoded as **lowercase zero-padded 8-char hex** (e.g., `0a1b2c3d`) everywhere they appear in JSON, metafields, or DB columns.

---

## 1. Email canonicalization

### Algorithm

```
canonical_email(raw):
  1. NFKC-normalize the input
  2. Lowercase (ASCII-only lowercase; don't touch non-ASCII)
  3. Trim leading/trailing whitespace
  4. If "@" not present → return null (invalid email; score 0)
  5. Split once at the last "@" into (local, domain)
  6. Strip all whitespace from local and domain
  7. Trim everything from the first "+" in local (inclusive) to end
  8. If domain is in GMAIL_DOMAINS → remove all "." from local
  9. If local is empty after stripping → return null
  10. Return "<local>@<domain>"

GMAIL_DOMAINS = ["gmail.com", "googlemail.com"]
```

### Test vectors

| Input | Canonical |
|---|---|
| `Khoi.Nguyen@Gmail.com` | `khoinguyen@gmail.com` |
| `khoi.nguyen+promo@gmail.com` | `khoinguyen@gmail.com` |
| `khoi.nguyen@googlemail.com` | `khoinguyen@googlemail.com` |
| `  KHOI+anything@OUTLOOK.COM ` | `khoi@outlook.com` |
| `khoi.gia.nguyen@yahoo.com` | `khoi.gia.nguyen@yahoo.com` |
| `khoi.nguyen@` (missing domain) | `null` |
| `@gmail.com` (empty local) | `null` |
| `khoi nguyen@gmail.com` (space in local) | `khoinguyen@gmail.com` |

### Rationale

- Gmail dot-stripping is a documented Google behaviour (dots in gmail local-parts are ignored by Google's mail routing). Safe.
- Stripping `+tag` is universally safe: mail servers that support plus-aliasing deliver to the non-plus address. Providers that don't support it simply don't create addresses containing `+`.
- We do NOT canonicalize other providers' aliasing schemes (e.g., Outlook's `-tag`) because they vary and false-canonicalization would merge different people.

### MVP limitation: NFKC (version 1 only)

To keep the Rust crate dependency-free (Invariant 4), the Rust implementation of `canonical_email` treats NFKC normalization as a **pass-through** — the raw input bytes flow straight into step 2. The Node implementation calls `String.prototype.normalize("NFKC")`, which is built into V8 and incurs no dependency cost.

For the ASCII-dominant email space (virtually all real-world email local-parts and domains are ASCII after step 2's lowercase), the two implementations produce **byte-identical output**. The divergence only surfaces for non-ASCII inputs whose NFKC form differs from their raw form (e.g., the full-width Latin character `Ａ` would become `A` in Node but remain `Ａ` in Rust).

We accept this divergence in `v1`. When we observe non-ASCII email inputs in production that actually matter, we will either (a) add the `unicode-normalization` crate to the Rust side or (b) implement a minimal NFKC table for the compatibility equivalents we care about. Either path **bumps `NORMALIZATION_VERSION` to 2** per §11 and rebuilds `docs/test-fixtures/hash-vectors.json` + any fingerprint metafield shards.

---

## 2. Phone E.164 normalization

### Assumption

Shopify's `cart.buyerIdentity.phone` is commonly already in E.164 format (e.g., `+84901234567`). When it isn't, we apply minimal best-effort normalization. Anything that doesn't parse cleanly returns `null` (phone signal skipped).

### Algorithm

```
canonical_phone(raw, default_country_e164_prefix):
  1. If raw is null or empty → null
  2. Strip all whitespace, ASCII dashes "-", parens "()", dots "."
  3. If starts with "+" → keep leading "+", keep only digits after
  4. Else if starts with "00" → replace "00" with "+", keep only digits after
  5. Else if starts with "0" → remove leading "0", prepend default_country_e164_prefix
  6. Else → prepend default_country_e164_prefix
  7. Result must match /^\+[1-9]\d{6,14}$/ — if not, return null
  8. Return result
```

`default_country_e164_prefix` is read per-shop from `Shop.defaultCountryCallingCode` (populated on install from the shop's country). If not set, return `null` for inputs without a leading `+` or `00`.

### Test vectors (assuming default prefix = "+84")

| Input | Canonical |
|---|---|
| `+84 901 234 567` | `+84901234567` |
| `+84-901-234-567` | `+84901234567` |
| `0084901234567` | `+84901234567` |
| `0901234567` | `+84901234567` |
| `901234567` | `+84901234567` |
| `(090) 123 4567` | `+84901234567` |
| `` (empty) | `null` |
| `not-a-phone` | `null` |
| `+1` (too short) | `null` |

---

## 3. Address normalization

### Input structure

```
raw_address = {
  line1:       string,
  line2:       string | null,
  city:        string | null,
  zip:         string | null,
  countryCode: string (ISO-3166-1 alpha-2, e.g., "VN", "US")
}
```

### Algorithm — normalize each field

```
normalize_string(s):
  1. If null or empty → ""
  2. NFKD-normalize (decompose diacritics)
  3. Strip Unicode combining marks (category Mn) — removes accents
  4. Lowercase (ASCII)
  5. Replace every character not in [a-z0-9 ] with a single space
  6. Collapse runs of whitespace to single space
  7. Trim leading/trailing whitespace
  8. Apply SUFFIX_MAP word-by-word (see below)
```

```
SUFFIX_MAP (abbreviation normalization, case-insensitive):
  "street"   → "st"
  "str"      → "st"
  "avenue"   → "ave"
  "av"       → "ave"
  "road"     → "rd"
  "boulevard"→ "blvd"
  "drive"    → "dr"
  "lane"     → "ln"
  "place"    → "pl"
  "court"    → "ct"
  "terrace"  → "ter"
  "apartment"→ "apt"
  "suite"    → "ste"
  "number"   → "no"
```

Split into whitespace-separated tokens, replace each token via SUFFIX_MAP if present, rejoin with single space.

### Three forms

Each normalized address produces three keys:

```
full_key(addr):
  n1 = normalize_string(line1)
  n2 = normalize_string(line2)
  zip = normalize_string(zip)
  cc  = countryCode.upper()
  return f"{n1}|{n2}|{zip}|{cc}"

house_key(addr):                // "same building, unit ignored"
  n1 = normalize_string(line1)
  n1_no_num = strip_leading_house_number(n1)  // see below
  zip = normalize_string(zip)
  cc  = countryCode.upper()
  return f"{n1_no_num}|{zip}|{cc}"

street_key(addr):                // "same street, house number ignored"
  n1 = normalize_string(line1)
  n1_no_num = strip_leading_house_number(n1)
  zip = normalize_string(zip)
  cc  = countryCode.upper()
  return f"{n1_no_num}|{zip}|{cc}"
  (same as house_key for now; reserved if we add house-bucket fuzzy matching later)


strip_leading_house_number(s):
  tokens = s.split(" ")
  if tokens.length >= 1 and tokens[0] matches /^\d+[a-z]?$/ :
    return tokens[1..].join(" ")
  return s
```

### Test vectors

| Input line1 | zip | cc | full_key | house_key |
|---|---|---|---|---|
| `123 Main Street` | `94102` | `US` | `123 main st\|\|94102\|US` | `main st\|94102\|US` |
| `125 Main St` | `94102` | `US` | `125 main st\|\|94102\|US` | `main st\|94102\|US` |
| `123 Main St., Apt 4B` | `94102` | `US` | `123 main st apt 4b\|\|94102\|US` | `main st apt 4b\|94102\|US` |
| `Số 12 Đường Lê Lợi` | `70000` | `VN` | `so 12 duong le loi\|\|70000\|VN` | `so 12 duong le loi\|70000\|VN` |
| `` | `94102` | `US` | `\|\|94102\|US` | `\|94102\|US` |

Note: `house_key` and `street_key` produce the same value in MVP. `street_key` is reserved for a future house-number bucket implementation (ranges of 10) and currently aliases to `house_key`.

---

## 4. Trigram generation

Used as input to MinHash for fuzzy email/address matching.

### For email MinHash

```
email_trigrams(canonical_email):
  1. Take local part only (everything before "@")
  2. If length < 3 → empty set
  3. Generate all consecutive 3-byte windows over the UTF-8 bytes
  4. Return as a set (deduplicated)
```

Why UTF-8 bytes not characters: byte-stable across Node `Buffer` and Rust `&[u8]`. For ASCII emails this is identical to char-trigrams. For non-ASCII (rare in email local-parts but possible), both implementations agree.

### For address MinHash

```
address_trigrams(normalized_line1, zip, country_code):
  1. combined = f"{normalized_line1} {zip} {country_code}"
  2. tokens = combined.split(" ")  (split on single space; already collapsed)
  3. For each token of length >= 3: generate consecutive 3-byte windows
  4. Return the union as a set
```

Token-scoped trigrams (not across-token) mean `"main st"` produces `{mai, ain, in_, n_s, _st}` differently than `main + st`. We use **token-scoped** (no crossing token boundaries) to avoid spurious matches.

### Test vectors

| Input | Trigrams |
|---|---|
| `khoinguyen` (email local) | `{kho, hoi, oin, ing, ngu, guy, uye, yen}` |
| `testerkhoi` (email local) | `{tes, est, ste, ter, erk, rkh, kho, hoi}` |
| `kh` (too short) | `{}` |
| `main st 94102 us` (address combined) | `{mai, ain, 941, 410, 102}` |

---

## 5. FNV-1a 32-bit hash

The only hash function used throughout this spec. No cryptographic hash, no external crates.

### Reference implementation

```
FNV1A_OFFSET_BASIS = 0x811c9dc5     // decimal 2166136261
FNV1A_PRIME        = 0x01000193     // decimal 16777619

fnv1a_32(bytes):
  hash = FNV1A_OFFSET_BASIS
  for byte in bytes:
    hash = hash XOR byte
    hash = (hash * FNV1A_PRIME) mod 2^32
  return hash
```

Both Node and Rust must perform the multiplication as unsigned 32-bit with explicit wrapping. In Node: `Math.imul` + `>>> 0`. In Rust: `u32::wrapping_mul`.

### Salted variant

```
fnv1a_salted(salt_bytes, input_bytes):
  return fnv1a_32(salt_bytes + input_bytes)
```

Where `+` is byte concatenation. No separator.

### Test vectors

Let `salt_bytes = UTF-8 bytes of "test-salt-xyz"` (13 bytes).

| Input string | fnv1a_32(bytes) | fnv1a_salted(salt, bytes) |
|---|---|---|
| `""` | `811c9dc5` | computed, see test fixtures |
| `"a"` | `e40c292c` | — |
| `"hello"` | `4f9f2cab` | — |
| `"khoinguyen@gmail.com"` | to fill | to fill |

Exact salted values are listed in `test-fixtures/hash-vectors.json` once the implementation exists. The unsalted values above are canonical from FNV test suites and MUST verify on both sides as the first implementation sanity check.

---

## 6. MinHash (bottom-K)

Compact fingerprint for a set of trigrams. K=4.

### Algorithm

```
minhash_sketch(trigram_set, salt_bytes):
  hashes = []
  for trigram in trigram_set:
    hashes.append(fnv1a_salted(salt_bytes, trigram))
  sort(hashes) ascending
  take first K=4 values
  if fewer than K trigrams: pad with 0xffffffff up to length K
  return [h0, h1, h2, h3]
```

Output: always a fixed-length array of 4 u32 values.

Why bottom-K (not classical MinHash with K hash functions): equivalent quality for Jaccard estimation at small K, simpler to implement identically in two languages, half the work.

### Jaccard similarity estimation

```
jaccard(sketch_a, sketch_b):
  union = set(sketch_a) | set(sketch_b)
  take 4 smallest values of union
  intersection_count = |{x in those 4 smallest that are in both sketch_a and sketch_b}|
  return intersection_count / 4.0
```

Similarity is always one of `{0.0, 0.25, 0.5, 0.75, 1.0}` for K=4.

Thresholds from the system design:
- `≥ 0.15` → MinHash similarity match (weight 4)
- `≥ 0.40` → strong MinHash similarity match (weight 6)

At K=4 the effective thresholds become:
- `sim ≥ 0.25` → weight 4 (anything below 0.25 is 0)
- `sim ≥ 0.50` → weight 6

So the scoring doc should use `{0, 4, 6}` based on `sim ∈ {0, 0.25, ≥0.5}`. This is precise and matches what K=4 can express.

### Serialization (for DB and metafield)

A sketch is stored as **8 lowercase hex chars per value, concatenated, no separator**. `[0x1a2b3c4d, 0x00000001, 0x7fffffff, 0xffffffff]` → `1a2b3c4d000000017fffffffffffffff` (32 hex chars = 16 bytes).

In the metafield shard, sketches are stored as a JSON array of these 32-char strings:

```json
{
  "v": 1,
  "sketches": ["1a2b3c4d000000017fffffffffffffff", "..."]
}
```

---

## 7. Salt handling

### Per-shop salt generation

On shop install:
```
salt_bytes = crypto.random_bytes(32)
Shop.salt = hex(salt_bytes)
```

### Salt binding to input

Every hash operation takes the shop's salt implicitly. The full hash contract is:

```
hash_for_lookup(signal_type_tag, normalized_value, shop_salt):
  tag_bytes = UTF-8 bytes of signal_type_tag  // e.g., "email_canonical", "phone", "addr_full"
  delimiter = 0x00 byte
  input_bytes = shop_salt || delimiter || tag_bytes || delimiter || normalized_value_bytes
  return fnv1a_32(input_bytes)
```

The signal-type tag prevents cross-signal collisions (e.g., a phone that happens to hash to the same value as an email canonical).

### Signal type tags

| Signal | Tag string |
|---|---|
| Phone | `phone` |
| Email canonical | `email_canonical` |
| Address full | `addr_full` |
| Address house | `addr_house` |
| IP /24 | `ip_v4_24` |
| IP /48 | `ip_v6_48` |

MinHash sketches use the same salt+tag prefix per trigram:

```
trigram_hash(trigram, signal_type_tag, shop_salt):
  input = shop_salt || 0x00 || tag || 0x00 || trigram
  return fnv1a_32(input)
```

MinHash tags:
- `email_trigram` for email local-part trigrams
- `addr_trigram` for address trigrams

---

## 8. Reference pseudocode

### Node.js (authoritative side, webhook handler)

```typescript
// src/lib/normalize.ts
export function canonicalEmail(raw: string): string | null { /* impl per §1 */ }
export function canonicalPhone(raw: string, defaultCC: string): string | null { /* §2 */ }
export function addressKeys(addr: Address): { full: string, house: string } { /* §3 */ }
export function emailTrigrams(canonical: string): Set<string> { /* §4 */ }
export function addressTrigrams(n1: string, zip: string, cc: string): Set<string> { /* §4 */ }

// src/lib/hash.ts
export function fnv1a32(bytes: Uint8Array): number { /* §5 */ }
export function hashForLookup(tag: SignalTag, value: string, salt: Uint8Array): string { /* §7 */ }
export function minhashSketch(trigrams: Set<string>, tag: TrigramTag, salt: Uint8Array): [number, number, number, number] { /* §6 */ }
export function jaccard(a: Sketch, b: Sketch): number { /* §6 */ }
```

### Rust (Function side)

```rust
// shared-lib/src/normalize.rs  (vendored into each Function extension)
pub fn canonical_email(raw: &str) -> Option<String> { /* §1 */ }
pub fn canonical_phone(raw: &str, default_cc: &str) -> Option<String> { /* §2 */ }
pub fn address_keys(line1: &str, line2: Option<&str>, zip: &str, cc: &str) -> (String, String) { /* §3 */ }
pub fn email_trigrams(canonical: &str) -> HashSet<[u8; 3]> { /* §4 */ }
pub fn address_trigrams(n1: &str, zip: &str, cc: &str) -> HashSet<[u8; 3]> { /* §4 */ }

// shared-lib/src/hash.rs
pub fn fnv1a_32(bytes: &[u8]) -> u32 { /* §5 */ }
pub fn hash_for_lookup(tag: SignalTag, value: &str, salt: &[u8]) -> u32 { /* §7 */ }
pub fn minhash_sketch(trigrams: &HashSet<[u8; 3]>, tag: TrigramTag, salt: &[u8]) -> [u32; 4] { /* §6 */ }
pub fn jaccard(a: &[u32; 4], b: &[u32; 4]) -> u8 { /* §6, returns 0..4, caller divides by 4 */ }
```

**The same `.test-fixtures/hash-vectors.json` file is consumed by both sides in CI.** Any drift fails both test suites.

---

## 9. Test fixture format

`.test-fixtures/hash-vectors.json` (committed alongside code):

```json
{
  "salt_hex": "746573742d73616c742d78797a",
  "email": [
    { "in": "Khoi.Nguyen@Gmail.com", "canonical": "khoinguyen@gmail.com", "hash": "..." },
    ...
  ],
  "phone": [
    { "in": "+84 901 234 567", "default_cc": "+84", "canonical": "+84901234567", "hash": "..." }
  ],
  "address": [
    { "in": { "line1": "123 Main St", "zip": "94102", "cc": "US" },
      "full_key": "123 main st||94102|US",
      "full_hash": "...",
      "house_key": "main st|94102|US",
      "house_hash": "..." }
  ],
  "email_minhash": [
    { "canonical": "khoinguyen@gmail.com",
      "trigrams": ["kho", "hoi", "oin", "ing", "ngu", "guy", "uye", "yen"],
      "sketch": ["...", "...", "...", "..."] }
  ],
  "jaccard": [
    { "a_sketch": [...], "b_sketch": [...], "expected_count": 2 }
  ]
}
```

---

## 10. Non-goals (things this spec explicitly does not do)

| Not this | Why |
|---|---|
| Levenshtein edit distance | Post-order authoritative side can use it with Prisma candidate sets; Function cannot afford runtime scan |
| Soundex / Metaphone phonetic matching | English-centric; diacritic-stripped trigrams cover Vietnamese/French/German names already |
| libpostal address parsing | Can't run in Function; use in Node side for post-order if we need it later |
| Email domain MX validation | Runtime I/O, not deterministic |
| Phone country validation via libphonenumber | Too large for Function binary (256 KB limit); we accept imperfect E.164 |

---

## 11. Change management

This spec is versioned. The fingerprint format includes a version tag (`"v": 1` in shard metafields). When a rule changes:

1. Bump the version to `v: 2`.
2. Rust and Node both check the version; if the shard is `v: 1`, they use the old logic or trigger a rebuild.
3. Background job re-scans the Prisma ledger with the new rules and writes a `v: 2` shard.
4. Only after rebuild completes do we activate the new Function code that expects `v: 2`.

This prevents silent regressions during rollout.
