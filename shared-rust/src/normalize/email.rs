//! Email canonicalization + trigram generation.
//!
//! See: docs/normalization-spec.md §1, §4
//!
//! # NFKC limitation (MVP, `NORMALIZATION_VERSION = 1`)
//!
//! Per `docs/normalization-spec.md §1` the first step of `canonical_email` is
//! "NFKC-normalize the input". Shared-rust is constrained to zero external
//! crates (see `docs/normalization-spec.md` Invariant 4 — the Function
//! extensions vendor this crate and must stay under the 256 KB wasm limit).
//! Rust's standard library does not ship NFKC. We therefore implement NFKC as
//! **pass-through** here: ASCII inputs are unaffected, and non-ASCII inputs
//! flow through unchanged. The Node port calls `String.prototype.normalize`
//! which does do full NFKC. For the ASCII-dominant email space this is a
//! non-issue; revisit and bump `NORMALIZATION_VERSION` when we need it.

const GMAIL_DOMAINS: &[&str] = &["gmail.com", "googlemail.com"];

/// Returns the canonical form of an email address, or `None` when the input
/// is not a structurally valid email. See `docs/normalization-spec.md §1`.
pub fn canonical_email(raw: &str) -> Option<String> {
    // 1. NFKC — pass-through in v1 (see module docs).
    // 2 + 3. Lowercase (ASCII-only) + trim surrounding whitespace.
    // We do these together in one pass over the trimmed slice to avoid
    // allocating a second intermediate String.
    let trimmed = raw.trim();
    let lower: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii() {
                c.to_ascii_lowercase()
            } else {
                c
            }
        })
        .collect();

    // 4 + 5. Require an `@`, split at the LAST one.
    let at_idx = lower.rfind('@')?;
    let (local_raw, domain_with_at) = lower.split_at(at_idx);
    // `domain_with_at` starts with the '@'; skip it.
    let domain_raw = &domain_with_at[1..];

    // 6. Strip all whitespace from local and domain.
    let mut local: String = local_raw.chars().filter(|c| !c.is_whitespace()).collect();
    let domain: String = domain_raw.chars().filter(|c| !c.is_whitespace()).collect();

    // 7. Trim from the first '+' in local (inclusive) to end.
    if let Some(plus_idx) = local.find('+') {
        local.truncate(plus_idx);
    }

    // 8. Gmail/Googlemail: strip dots from local.
    if GMAIL_DOMAINS.iter().any(|d| *d == domain.as_str()) {
        local.retain(|c| c != '.');
    }

    // 9. Empty local after stripping → invalid.
    if local.is_empty() {
        return None;
    }

    // 10. Reassemble. Note: domain can be empty (e.g., "foo@"); spec §1 step 4
    // only requires the '@' to be present, but the test vector
    // `"khoi.nguyen@"` expects `null`. We treat an empty domain as invalid
    // too so that canonical emails always contain at least one character on
    // each side of '@'.
    if domain.is_empty() {
        return None;
    }

    Some(format!("{}@{}", local, domain))
}

/// Returns a sorted, deduplicated `Vec` of 3-byte windows over the UTF-8 bytes
/// of the email's local part. Sorting makes the output deterministic for
/// fixture comparison. See `docs/normalization-spec.md §4`.
pub fn email_trigrams(canonical: &str) -> Vec<[u8; 3]> {
    // Take the local part only — everything before the last '@'. If there is
    // no '@' (shouldn't happen for a canonical email, but be defensive) treat
    // the whole input as the local part.
    let local = match canonical.rfind('@') {
        Some(idx) => &canonical[..idx],
        None => canonical,
    };

    let bytes = local.as_bytes();
    if bytes.len() < 3 {
        return Vec::new();
    }

    // Collect consecutive 3-byte windows, dedupe, sort.
    let mut out: Vec<[u8; 3]> = Vec::with_capacity(bytes.len().saturating_sub(2));
    for w in bytes.windows(3) {
        let tri: [u8; 3] = [w[0], w[1], w[2]];
        out.push(tri);
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_gmail_dot_and_case() {
        assert_eq!(
            canonical_email("Khoi.Nguyen@Gmail.com"),
            Some("khoinguyen@gmail.com".to_string())
        );
    }

    #[test]
    fn canonical_plus_tag_gmail() {
        assert_eq!(
            canonical_email("khoi.nguyen+promo@gmail.com"),
            Some("khoinguyen@gmail.com".to_string())
        );
    }

    #[test]
    fn canonical_googlemail_keeps_domain() {
        assert_eq!(
            canonical_email("khoi.nguyen@googlemail.com"),
            Some("khoinguyen@googlemail.com".to_string())
        );
    }

    #[test]
    fn canonical_outlook_trim_plus_and_case() {
        assert_eq!(
            canonical_email("  KHOI+anything@OUTLOOK.COM "),
            Some("khoi@outlook.com".to_string())
        );
    }

    #[test]
    fn canonical_yahoo_keeps_dots() {
        assert_eq!(
            canonical_email("khoi.gia.nguyen@yahoo.com"),
            Some("khoi.gia.nguyen@yahoo.com".to_string())
        );
    }

    #[test]
    fn canonical_missing_domain_is_none() {
        assert_eq!(canonical_email("khoi.nguyen@"), None);
    }

    #[test]
    fn canonical_empty_local_is_none() {
        assert_eq!(canonical_email("@gmail.com"), None);
    }

    #[test]
    fn canonical_whitespace_inside_local_is_stripped() {
        assert_eq!(
            canonical_email("khoi nguyen@gmail.com"),
            Some("khoinguyen@gmail.com".to_string())
        );
    }

    #[test]
    fn canonical_no_at_sign_is_none() {
        assert_eq!(canonical_email("no-at-sign"), None);
    }

    #[test]
    fn trigrams_khoinguyen() {
        let got = email_trigrams("khoinguyen@x.com");
        let want: Vec<[u8; 3]> = vec![
            *b"hoi", *b"ing", *b"kho", *b"ngu", *b"oin", *b"uye", *b"yen", *b"guy",
        ]
        .into_iter()
        .collect::<Vec<_>>();
        let mut want_sorted = want.clone();
        want_sorted.sort_unstable();
        assert_eq!(got, want_sorted);
    }

    #[test]
    fn trigrams_too_short() {
        assert_eq!(email_trigrams("kh@x.com"), Vec::<[u8; 3]>::new());
    }

    #[test]
    fn trigrams_dedup() {
        // "ababab" should produce {aba, bab} only, not 4 windows.
        let got = email_trigrams("ababab@x.com");
        assert_eq!(got.len(), 2);
        assert!(got.contains(&[b'a', b'b', b'a']));
        assert!(got.contains(&[b'b', b'a', b'b']));
    }
}
