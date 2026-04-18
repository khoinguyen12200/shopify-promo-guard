//! See: docs/normalization-spec.md §5, §7
//! Fixture: docs/test-fixtures/hash-vectors.json
//!
//! This test enforces that the Rust hash implementation in
//! `shared-rust/src/hash.rs` produces the hex vectors committed in the shared
//! JSON fixture. The Node port (`app/lib/hash.server.ts`) is exercised by the
//! same JSON via `scripts/verify-fixtures.ts`; the union of both is what
//! `make test-fixture-parity` runs.

use promo_guard_shared::hash::{fnv1a_32, fnv1a_salted, hash_for_lookup, hash_to_hex};
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct F {
    version: u32,
    salt_utf8: String,
    fnv1a_32: Vec<Case32>,
    fnv1a_salted: Vec<CaseSalted>,
    hash_for_lookup: Vec<CaseLookup>,
}

#[derive(Deserialize)]
struct Case32 {
    input_utf8: String,
    hex: String,
}

#[derive(Deserialize)]
struct CaseSalted {
    input_utf8: String,
    hex: String,
}

#[derive(Deserialize)]
struct CaseLookup {
    tag: String,
    value_utf8: String,
    hex: String,
}

#[test]
fn hash_vectors_match_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/test-fixtures/hash-vectors.json"
    );
    let raw = fs::read_to_string(path).expect("read fixture");
    let fx: F = serde_json::from_str(&raw).expect("parse fixture");
    assert_eq!(fx.version, 1, "fixture version");
    let salt = fx.salt_utf8.as_bytes();
    for c in &fx.fnv1a_32 {
        assert_eq!(
            hash_to_hex(fnv1a_32(c.input_utf8.as_bytes())),
            c.hex,
            "fnv1a_32({:?})",
            c.input_utf8
        );
    }
    for c in &fx.fnv1a_salted {
        assert_eq!(
            hash_to_hex(fnv1a_salted(salt, c.input_utf8.as_bytes())),
            c.hex,
            "fnv1a_salted({:?})",
            c.input_utf8
        );
    }
    for c in &fx.hash_for_lookup {
        assert_eq!(
            hash_to_hex(hash_for_lookup(&c.tag, c.value_utf8.as_bytes(), salt)),
            c.hex,
            "hash_for_lookup({:?}, {:?})",
            c.tag,
            c.value_utf8
        );
    }
}
