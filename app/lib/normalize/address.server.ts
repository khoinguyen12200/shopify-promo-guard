/**
 * See: docs/normalization-spec.md §3 (normalize_string, full/house keys),
 *      docs/normalization-spec.md §4 (address_trigrams)
 *
 * Fixture: docs/test-fixtures/address-vectors.json
 * Rust port: shared-rust/src/normalize/address.rs
 *
 * Parity contract: this module and the Rust port MUST produce byte-identical
 * output for every case in the fixture file above.
 */

// ---------------------------------------------------------------------------
// SUFFIX_MAP — docs/normalization-spec.md §3 SUFFIX_MAP
// ---------------------------------------------------------------------------
const SUFFIX_MAP: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  place: "pl",
  court: "ct",
  terrace: "ter",
  apartment: "apt",
  suite: "ste",
  number: "no",
};

/**
 * Core string normalizer per §3.
 *
 * 1. null/empty → ""
 * 2. NFKD-normalize (Node `String.prototype.normalize("NFKD")`)
 * 3. Strip Unicode combining marks (category Mn) — drop code points whose
 *    `\p{Mn}` flag is set. This is equivalent to removing the diacritics that
 *    NFKD decomposes. Vietnamese Đ/đ is NOT decomposed by NFKD (it has an
 *    integral stroke), so we map it explicitly.
 * 4. ASCII-lowercase
 * 5. Replace every char not in [a-z0-9 ] with a single space
 * 6. Collapse whitespace runs to a single space
 * 7. Trim
 * 8. Apply SUFFIX_MAP word-by-word
 */
export function normalizeString(s: string): string {
  if (!s) return "";

  // Steps 2 + 3: NFKD then strip combining marks + map special chars.
  const nfkd = s.normalize("NFKD");
  let stripped = "";
  for (const ch of nfkd) {
    // Vietnamese Đ/đ — integral stroke, NFKD won't decompose it.
    if (ch === "Đ" || ch === "đ") {
      stripped += "d";
      continue;
    }
    // Drop Unicode combining marks (U+0300–U+036F and a few others).
    // Using regex on each char is safe here for correctness.
    if (/\p{Mn}/u.test(ch)) continue;
    stripped += ch;
  }

  // Steps 4 + 5 + 6 + 7: ASCII lowercase, replace non-[a-z0-9 ], collapse, trim.
  let out = "";
  let prevSpace = true; // suppress leading space
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    let ch = stripped[i];
    // ASCII uppercase → lowercase
    if (code >= 0x41 && code <= 0x5a) {
      ch = String.fromCharCode(code + 0x20);
    }
    const keep =
      (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (keep) {
      out += ch;
      prevSpace = false;
    } else {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
    }
  }
  // Trim trailing space
  if (out.endsWith(" ")) out = out.slice(0, -1);

  // Step 8: SUFFIX_MAP
  return applySuffixMap(out);
}

function applySuffixMap(s: string): string {
  if (!s) return "";
  return s
    .split(" ")
    .map((tok) => SUFFIX_MAP[tok] ?? tok)
    .join(" ");
}

/**
 * Remove the leading house number from a normalized line1 string.
 * Drops `tokens[0]` if it matches `/^\d+[a-z]?$/`.
 */
export function stripLeadingHouseNumber(s: string): string {
  if (!s) return "";
  const tokens = s.split(" ");
  if (isHouseNumberToken(tokens[0])) {
    return tokens.slice(1).join(" ");
  }
  return s;
}

function isHouseNumberToken(tok: string): boolean {
  if (!tok) return false;
  return /^\d+[a-z]?$/.test(tok);
}

export interface AddressInput {
  line1: string;
  line2: string;
  zip: string;
  countryCode: string;
}

/**
 * Full key: `{n1}|{n2}|{zip}|{CC}`.
 */
export function fullKey(addr: AddressInput): string {
  const n1 = normalizeString(addr.line1);
  const n2 = normalizeString(addr.line2);
  const zip = normalizeString(addr.zip);
  const cc = addr.countryCode.toUpperCase();
  return `${n1}|${n2}|${zip}|${cc}`;
}

/**
 * House key: `{n1_no_num}|{zip}|{CC}` — line1 with leading house number stripped.
 */
export function houseKey(addr: AddressInput): string {
  const n1 = normalizeString(addr.line1);
  const n1NoNum = stripLeadingHouseNumber(n1);
  const zip = normalizeString(addr.zip);
  const cc = addr.countryCode.toUpperCase();
  return `${n1NoNum}|${zip}|${cc}`;
}

/**
 * Address trigrams for MinHash input (§4):
 *
 * 1. combined = `${n1} ${zip} ${cc}` (already normalized/lowercased)
 * 2. Split on single space
 * 3. For each token ≥3 chars: 3-char (byte) windows
 * 4. Deduplicate + sort
 *
 * Returns sorted array of 3-char strings.
 */
export function addressTrigrams(n1: string, zip: string, cc: string): string[] {
  const combined = `${n1} ${zip} ${cc}`;
  const set = new Set<string>();
  for (const tok of combined.split(" ")) {
    if (tok.length < 3) continue;
    // Encode to UTF-8 bytes, slide windows.
    const bytes = Buffer.from(tok, "utf8");
    for (let i = 0; i + 3 <= bytes.length; i++) {
      set.add(bytes.slice(i, i + 3).toString("utf8"));
    }
  }
  return Array.from(set).sort();
}
