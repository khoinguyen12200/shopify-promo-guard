//! Address normalization, house-key derivation, and address trigrams.
//!
//! See: docs/normalization-spec.md §3 (normalize_string, full/house keys),
//!      docs/normalization-spec.md §4 (address_trigrams)
//! Fixture: docs/test-fixtures/address-vectors.json
//!
//! Parity contract: this module and `app/lib/normalize/address.server.ts`
//! MUST produce byte-identical output for every case in the fixture above.

use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

/// Input record matching `docs/normalization-spec.md §3` "Input structure".
///
/// `line2` may be empty (meaning absent); the spec treats null/empty line2
/// identically via `normalize_string`.
pub struct Address {
    pub line1: String,
    pub line2: String,
    pub zip: String,
    /// ISO-3166-1 alpha-2, e.g. "US", "VN". Uppercased on output.
    pub country_code: String,
}

/// Core string normalizer. See §3 "Algorithm — normalize each field":
///
/// 1. null/empty → ""
/// 2. NFKD-normalize
/// 3. Strip Unicode combining marks (category Mn)
/// 4. Lowercase (ASCII)
/// 5. Replace every char not in `[a-z0-9 ]` with a single space
/// 6. Collapse runs of whitespace to a single space
/// 7. Trim
/// 8. Apply `SUFFIX_MAP` word-by-word
pub fn normalize_string(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }

    // Steps 2 + 3: NFKD then drop combining marks (category Mn).
    // Also fold letters that NFKD does NOT decompose but which we still want
    // treated as their base form — notably Vietnamese Đ/đ (U+0110/U+0111)
    // whose stroke is integral to the codepoint. Expand this list only when
    // a new test vector demands it and bump `NORMALIZATION_VERSION` per §11.
    let mut stripped = String::with_capacity(s.len());
    for ch in s.nfkd() {
        if is_combining_mark(ch) {
            continue;
        }
        match ch {
            'Đ' | 'đ' => stripped.push('d'),
            _ => stripped.push(ch),
        }
    }

    // Steps 4 + 5 + 6 + 7: ASCII lowercase, replace non-[a-z0-9 ] with space,
    // collapse whitespace, trim. Done in a single pass over the codepoints.
    let mut out = String::with_capacity(stripped.len());
    let mut prev_space = true; // treat leading as space so we don't emit a leading ' '
    for ch in stripped.chars() {
        let mapped: char = if ch.is_ascii_uppercase() {
            ch.to_ascii_lowercase()
        } else {
            ch
        };
        let keep = matches!(mapped, 'a'..='z' | '0'..='9');
        if keep {
            out.push(mapped);
            prev_space = false;
        } else {
            // Any other char (including original whitespace and punctuation)
            // becomes a space; collapse runs.
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        }
    }
    // Trim trailing space (leading space was suppressed above).
    if out.ends_with(' ') {
        out.pop();
    }

    // Step 8: SUFFIX_MAP word-by-word.
    apply_suffix_map(&out)
}

/// Word-level abbreviation normalization (`§3 SUFFIX_MAP`).
/// Called after the output has been normalized to `[a-z0-9 ]+` with single spaces.
fn apply_suffix_map(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let mut pieces: Vec<&str> = Vec::with_capacity(8);
    for tok in s.split(' ') {
        pieces.push(map_suffix(tok));
    }
    pieces.join(" ")
}

/// Map one token via the SUFFIX_MAP table. Unknown tokens return as-is.
///
/// Table from docs/normalization-spec.md §3 SUFFIX_MAP.
fn map_suffix(tok: &str) -> &str {
    match tok {
        "street" | "str" => "st",
        "avenue" | "av" => "ave",
        "road" => "rd",
        "boulevard" => "blvd",
        "drive" => "dr",
        "lane" => "ln",
        "place" => "pl",
        "court" => "ct",
        "terrace" => "ter",
        "apartment" => "apt",
        "suite" => "ste",
        "number" => "no",
        other => other,
    }
}

/// Remove a leading house number from a normalized line1 string.
/// See §3: if `tokens[0]` matches `/^\d+[a-z]?$/`, drop it; otherwise return `s`.
pub fn strip_leading_house_number(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let mut it = s.split(' ');
    let Some(first) = it.next() else {
        return s.to_string();
    };
    if is_house_number_token(first) {
        // Rejoin the remainder — `split(' ')` yields the tail without the leading space.
        it.collect::<Vec<_>>().join(" ")
    } else {
        s.to_string()
    }
}

/// Matches `/^\d+[a-z]?$/`: one or more ASCII digits, optionally followed by
/// a single ASCII lowercase letter. Empty string does not match.
fn is_house_number_token(tok: &str) -> bool {
    let bytes = tok.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    // At least one digit.
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return false;
    }
    // Optional single lowercase letter.
    if i < bytes.len() && bytes[i].is_ascii_lowercase() {
        i += 1;
    }
    i == bytes.len()
}

/// Full address key: `{n1}|{n2}|{zip}|{CC}` (CC uppercased).
/// See §3 `full_key`.
pub fn full_key(addr: &Address) -> String {
    let n1 = normalize_string(&addr.line1);
    let n2 = normalize_string(&addr.line2);
    let zip = normalize_string(&addr.zip);
    let cc = addr.country_code.to_ascii_uppercase();
    format!("{n1}|{n2}|{zip}|{cc}")
}

/// House key: `{n1_no_num}|{zip}|{CC}` — line1 with its leading house number stripped.
/// See §3 `house_key` (also aliases as `street_key` for MVP).
pub fn house_key(addr: &Address) -> String {
    let n1 = normalize_string(&addr.line1);
    let n1_no_num = strip_leading_house_number(&n1);
    let zip = normalize_string(&addr.zip);
    let cc = addr.country_code.to_ascii_uppercase();
    format!("{n1_no_num}|{zip}|{cc}")
}

/// Address trigrams for MinHash input. See §4 address_trigrams:
///
/// 1. combined = f"{n1} {zip} {cc}"
/// 2. split on single space (the feeder has already collapsed/lowered)
/// 3. for each token with ≥3 UTF-8 bytes: emit consecutive 3-byte windows
/// 4. return the union (deduplicated, sorted for determinism)
pub fn address_trigrams(n1: &str, zip: &str, cc: &str) -> Vec<[u8; 3]> {
    let combined = format!("{n1} {zip} {cc}");
    let mut set: Vec<[u8; 3]> = Vec::new();
    for tok in combined.split(' ') {
        let bytes = tok.as_bytes();
        if bytes.len() < 3 {
            continue;
        }
        for w in bytes.windows(3) {
            let tri: [u8; 3] = [w[0], w[1], w[2]];
            if !set.contains(&tri) {
                set.push(tri);
            }
        }
    }
    set.sort();
    set
}
