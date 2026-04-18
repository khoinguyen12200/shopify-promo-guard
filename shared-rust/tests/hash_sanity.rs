//! See: docs/normalization-spec.md §5 (FNV-1a canonical vectors)
//! Fixture: docs/test-fixtures/hash-vectors.json

use promo_guard_shared::hash::{fnv1a_32, hash_to_hex};

#[test]
fn canonical_sanity() {
    assert_eq!(hash_to_hex(fnv1a_32(b"")), "811c9dc5");
    assert_eq!(hash_to_hex(fnv1a_32(b"a")), "e40c292c");
    assert_eq!(hash_to_hex(fnv1a_32(b"hello")), "4f9f2cab");
}
