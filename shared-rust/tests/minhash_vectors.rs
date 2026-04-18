//! See: docs/normalization-spec.md §6 (MinHash bottom-K)
//! Fixture: docs/test-fixtures/minhash-vectors.json
//!
//! Parity enforcement for the Rust MinHash implementation. The Node port
//! (`app/lib/minhash.server.ts`) is exercised by the same JSON fixture via
//! `app/lib/minhash.test.ts`.

use promo_guard_shared::minhash::{compute_sketch, has_sufficient_overlap, jaccard_estimate};
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct Fixture {
    version: u32,
    salt_utf8: String,
    sketches: Vec<SketchCase>,
    jaccard: Vec<JaccardCase>,
}

#[derive(Deserialize)]
struct SketchCase {
    label: String,
    trigrams: Vec<String>,
    expected_sketch: [u32; 4],
}

#[derive(Deserialize)]
struct JaccardCase {
    label: String,
    sketch_a: [u32; 4],
    sketch_b: [u32; 4],
    expected: f32,
}

fn load_fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/test-fixtures/minhash-vectors.json"
    );
    let data = fs::read_to_string(path).expect("failed to read minhash-vectors.json");
    serde_json::from_str(&data).expect("failed to parse minhash-vectors.json")
}

#[test]
fn test_version() {
    let f = load_fixture();
    assert_eq!(f.version, 1);
}

#[test]
fn test_sketches() {
    let f = load_fixture();
    let salt = f.salt_utf8.as_bytes();

    for case in &f.sketches {
        let trigrams: Vec<[u8; 3]> = case
            .trigrams
            .iter()
            .map(|t| {
                let b = t.as_bytes();
                assert_eq!(b.len(), 3, "trigram '{}' is not 3 bytes", t);
                [b[0], b[1], b[2]]
            })
            .collect();

        let sketch = compute_sketch(&trigrams, salt);
        assert_eq!(
            sketch, case.expected_sketch,
            "sketch mismatch for case '{}'",
            case.label
        );
    }
}

#[test]
fn test_jaccard() {
    let f = load_fixture();

    for case in &f.jaccard {
        let got = jaccard_estimate(&case.sketch_a, &case.sketch_b);
        assert!(
            (got - case.expected).abs() < 1e-6,
            "jaccard mismatch for case '{}': got {}, expected {}",
            case.label,
            got,
            case.expected
        );
    }
}

#[test]
fn test_has_sufficient_overlap() {
    // 1.0 similarity → meets any reasonable threshold
    let s = [466682748u32, 733189310, 846147091, 1741988834];
    assert!(has_sufficient_overlap(&s, &s, 1.0));
    assert!(has_sufficient_overlap(&s, &s, 0.5));

    // disjoint
    let a = [466682748u32, 733189310, 846147091, 1741988834];
    let b = [222153778u32, 810471649, 3647606906, 4159444007];
    assert!(!has_sufficient_overlap(&a, &b, 0.25));
}
