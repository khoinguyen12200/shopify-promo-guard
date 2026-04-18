//! See: docs/normalization-spec.md §3 (keys), §4 (trigrams)
//! Fixture: docs/test-fixtures/address-vectors.json
//!
//! Parity enforcement for the Rust address normalizer. The Node port
//! (`app/lib/normalize/address.server.ts`) is exercised by the same JSON via
//! `app/lib/normalize/address.test.ts`.

use promo_guard_shared::normalize::address::{
    address_trigrams, full_key, house_key, normalize_string, strip_leading_house_number, Address,
};
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct Fixture {
    version: u32,
    normalize_string: Vec<StrCase>,
    strip_leading_house_number: Vec<StrCase>,
    keys: Vec<KeyCase>,
    trigrams: Vec<TrigramCase>,
}

#[derive(Deserialize)]
struct StrCase {
    input: String,
    expected: String,
}

#[derive(Deserialize)]
struct KeyCase {
    addr: AddrCase,
    full: String,
    house: String,
}

#[derive(Deserialize)]
struct AddrCase {
    line1: String,
    line2: String,
    zip: String,
    country_code: String,
}

#[derive(Deserialize)]
struct TrigramCase {
    n1: String,
    zip: String,
    cc: String,
    expected: Vec<String>,
}

#[test]
fn address_vectors_match_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/test-fixtures/address-vectors.json"
    );
    let raw = fs::read_to_string(path).expect("read address fixture");
    let fx: Fixture = serde_json::from_str(&raw).expect("parse address fixture");
    assert_eq!(fx.version, 1, "fixture version");

    for c in &fx.normalize_string {
        assert_eq!(
            normalize_string(&c.input),
            c.expected,
            "normalize_string({:?})",
            c.input
        );
    }

    for c in &fx.strip_leading_house_number {
        assert_eq!(
            strip_leading_house_number(&c.input),
            c.expected,
            "strip_leading_house_number({:?})",
            c.input
        );
    }

    for c in &fx.keys {
        let addr = Address {
            line1: c.addr.line1.clone(),
            line2: c.addr.line2.clone(),
            zip: c.addr.zip.clone(),
            country_code: c.addr.country_code.clone(),
        };
        assert_eq!(full_key(&addr), c.full, "full_key({:?})", c.addr.line1);
        assert_eq!(house_key(&addr), c.house, "house_key({:?})", c.addr.line1);
    }

    for c in &fx.trigrams {
        let got = address_trigrams(&c.n1, &c.zip, &c.cc);
        // Re-encode as sorted deduplicated 3-char ASCII strings for comparison.
        let mut got_strs: Vec<String> = got
            .iter()
            .map(|w| String::from_utf8(w.to_vec()).expect("ascii trigram"))
            .collect();
        got_strs.sort();
        let mut want: Vec<String> = c.expected.clone();
        want.sort();
        assert_eq!(got_strs, want, "address_trigrams({:?})", c.n1);
    }
}
