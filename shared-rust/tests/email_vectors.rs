//! See: docs/normalization-spec.md §1, §4
//! Fixture: docs/test-fixtures/email-vectors.json
//!
//! Rust half of the email-normalization parity harness. The Node port
//! (`app/lib/normalize/email.server.ts`) is exercised by the same JSON via
//! `app/lib/normalize/email.test.ts`.

use promo_guard_shared::normalize::email::{canonical_email, email_trigrams};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fs;

#[derive(Deserialize)]
struct F {
    version: u32,
    canonical: Vec<Canon>,
    trigrams: Vec<Trig>,
}

#[derive(Deserialize)]
struct Canon {
    input: String,
    expected: Option<String>,
}

#[derive(Deserialize)]
struct Trig {
    canonical_local: String,
    expected: Vec<String>,
}

#[test]
fn email_vectors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../docs/test-fixtures/email-vectors.json"
    );
    let raw = fs::read_to_string(path).expect("read fixture");
    let fx: F = serde_json::from_str(&raw).expect("parse fixture");
    assert_eq!(fx.version, 1, "fixture version");

    for c in &fx.canonical {
        assert_eq!(
            canonical_email(&c.input),
            c.expected,
            "canonical_email input={:?}",
            c.input
        );
    }

    for t in &fx.trigrams {
        // Trigrams are defined over the local part only; append a dummy
        // domain so `email_trigrams` sees a well-formed canonical email.
        let got: BTreeSet<String> =
            email_trigrams(&format!("{}@x.com", t.canonical_local))
                .iter()
                .map(|b| String::from_utf8(b.to_vec()).expect("utf8 trigram"))
                .collect();
        let want: BTreeSet<String> = t.expected.iter().cloned().collect();
        assert_eq!(got, want, "email_trigrams local={:?}", t.canonical_local);
    }
}
