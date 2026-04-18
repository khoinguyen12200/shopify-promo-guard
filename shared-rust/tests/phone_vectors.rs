//! See: docs/normalization-spec.md §2
//! Fixture: docs/test-fixtures/phone-vectors.json
//!
//! Parity test: the Rust `canonical_phone` must match the fixture expectations
//! that `app/lib/normalize/phone.test.ts` also asserts.

use promo_guard_shared::normalize::phone::canonical_phone;
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct F {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    input: String,
    default: Option<String>,
    expected: Option<String>,
}

#[test]
fn phone_vectors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/test-fixtures/phone-vectors.json"
    );
    let fx: F = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    for c in &fx.cases {
        assert_eq!(
            canonical_phone(&c.input, c.default.as_deref()),
            c.expected,
            "input={:?} default={:?}",
            c.input,
            c.default
        );
    }
}
