//! See: docs/normalization-spec.md §2
//!
//! Canonicalize a phone number to E.164.
//!
//! Fixture: docs/test-fixtures/phone-vectors.json
//! Node port: app/lib/normalize/phone.server.ts
//!
//! Per Invariant 4, no external crates are used. The algorithm is a literal
//! translation of the spec's pseudocode — strip formatting characters, resolve
//! the leading token into a `+` prefix, then validate against the E.164 shape
//! `^\+[1-9]\d{6,14}$`.

/// Canonicalize a raw phone string into E.164 form.
///
/// Returns `None` for any input that cannot be resolved into a valid E.164
/// number (missing default prefix, too short, non-digit body, etc.). The
/// `default_prefix` must include the leading `+` (e.g. `Some("+84")`).
pub fn canonical_phone(raw: &str, default_prefix: Option<&str>) -> Option<String> {
    // 1. null/empty → null
    if raw.is_empty() {
        return None;
    }

    // 2. Strip whitespace, ASCII dashes, parens, dots.
    let mut stripped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_whitespace() {
            continue;
        }
        match ch {
            '-' | '(' | ')' | '.' => continue,
            _ => stripped.push(ch),
        }
    }

    if stripped.is_empty() {
        return None;
    }

    // 3/4/5/6. Resolve the leading token into a `+`-prefixed digit string.
    let candidate = if let Some(rest) = stripped.strip_prefix('+') {
        let digits = keep_only_digits(rest);
        format!("+{}", digits)
    } else if let Some(rest) = stripped.strip_prefix("00") {
        let digits = keep_only_digits(rest);
        format!("+{}", digits)
    } else if let Some(rest) = stripped.strip_prefix('0') {
        let prefix = default_prefix?;
        let digits = keep_only_digits(rest);
        format!("{}{}", prefix, digits)
    } else {
        let prefix = default_prefix?;
        let digits = keep_only_digits(&stripped);
        format!("{}{}", prefix, digits)
    };

    // 7. Validate against ^\+[1-9]\d{6,14}$ — hand-rolled, no regex crate.
    if !is_valid_e164(&candidate) {
        return None;
    }

    // 8. Return.
    Some(candidate)
}

/// Retain only ASCII digits 0-9 from the input.
fn keep_only_digits(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Validate an E.164 string against `^\+[1-9]\d{6,14}$`.
///
/// That is: a leading `+`, then a non-zero leading digit, then between 6 and
/// 14 more digits (7 to 15 digits total after the `+`).
fn is_valid_e164(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes[0] != b'+' {
        return false;
    }
    let digits = &bytes[1..];
    if digits.len() < 7 || digits.len() > 15 {
        return false;
    }
    if digits[0] < b'1' || digits[0] > b'9' {
        return false;
    }
    for b in &digits[1..] {
        if !b.is_ascii_digit() {
            return false;
        }
    }
    true
}
