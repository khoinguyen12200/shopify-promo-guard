//! Checkout scoring — pure, deterministic, no I/O.
//!
//! Used by the Cart & Checkout Validation Function (wasm).
//!
//! See: docs/scoring-spec.md §4 and §5.1
//! Related: docs/function-queries-spec.md §1

use crate::scoring::constants::{
    THRESHOLD_HIGH, THRESHOLD_MEDIUM, W_ADDRESS_FULL_EXACT, W_ADDRESS_HOUSE_EXACT,
    W_ADDRESS_MINHASH_STRONG, W_ADDRESS_MINHASH_WEAK, W_CUSTOMER_TAG, W_EMAIL_CANONICAL_EXACT,
    W_EMAIL_MINHASH_STRONG, W_EMAIL_MINHASH_WEAK, W_PHONE_EXACT,
};

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/// All signal hashes and sketches derived from the incoming checkout.
///
/// `None` means the signal was absent (null/missing); skip that rule entirely.
/// Hashes are u32 values computed by `crate::hash::hash_for_lookup`.
/// Sketches are 4-band MinHash arrays (one band = one u32).
pub struct CheckoutSignals {
    pub email_hash: Option<u32>,
    pub phone_hash: Option<u32>,
    pub address_full_hash: Option<u32>,
    pub address_house_hash: Option<u32>,
    pub ip_hash: Option<u32>,
    pub device_hash: Option<u32>,
    pub email_sketch: Option<[u32; 4]>,
    pub address_sketch: Option<[u32; 4]>,
    /// Whether the cart contains a discount code that belongs to this offer.
    /// When false, scoring is skipped immediately (fast path).
    pub cart_has_guarded_code: bool,
    /// Whether the customer's account carries the "already redeemed" tag.
    pub customer_redeemed_tag: bool,
}

/// Prior-redemption data read from ledger shards (shop metafields).
///
/// All sets are plain `Vec<u32>` because the Function receives them already
/// deserialized from JSON. Hashes inside these vecs must have been produced
/// with the same normalization version and shop salt as the incoming signals.
#[derive(Debug, Default)]
pub struct RedemptionHashSet {
    pub email_hashes: Vec<u32>,
    pub phone_hashes: Vec<u32>,
    pub address_full_hashes: Vec<u32>,
    pub address_house_hashes: Vec<u32>,
    /// Kept for future post-order use; not evaluated at checkout.
    pub ip_hashes: Vec<u32>,
    /// Kept for future use; not evaluated at checkout.
    pub device_hashes: Vec<u32>,
    pub email_sketches: Vec<[u32; 4]>,
    pub address_sketches: Vec<[u32; 4]>,
}

/// The scoring outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Score in `[THRESHOLD_MEDIUM, THRESHOLD_HIGH)`.
    /// At checkout this is treated the same as Allow — only HIGH blocks.
    Review,
    Block,
}

#[derive(Debug)]
pub struct ScoreResult {
    pub score: u32,
    pub decision: Decision,
    /// Human-readable labels for every matched signal (checkout variant).
    pub matched_signals: Vec<&'static str>,
}

// ---------------------------------------------------------------------------
// MinHash helper
// ---------------------------------------------------------------------------

/// Count how many bands are identical between two 4-band MinHash sketches.
///
/// This is `jaccard_count` from scoring-spec.md §4.3/4.6.  Range: 0–4.
///
/// TODO(T10): once `crate::minhash` is implemented, delegate here.
/// For now we inline the trivial band comparison so this crate compiles
/// without a minhash dependency.
#[inline]
fn jaccard_count(a: &[u32; 4], b: &[u32; 4]) -> usize {
    a.iter().zip(b.iter()).filter(|(x, y)| x == y).count()
}

/// Best overlap (0–4) across a collection of stored sketches.
/// Returns 0 when `sketches` is empty.
fn best_sketch_overlap(incoming: &[u32; 4], sketches: &[[u32; 4]]) -> usize {
    sketches
        .iter()
        .map(|s| jaccard_count(incoming, s))
        .max()
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Score an incoming checkout against the prior-redemption ledger.
///
/// Implements scoring-spec.md §5.1 (checkout mode):
/// - Returns score 0 + Allow immediately when `cart_has_guarded_code` is false.
/// - Per signal family, only the **strongest tier** contributes.
///   Exact email OR fuzzy email — never both.
///   Exact full address > house address > fuzzy address — exactly one.
/// - Phone, email-family, address-family, and customer-tag are independent.
pub fn score_checkout(signals: &CheckoutSignals, set: &RedemptionHashSet) -> ScoreResult {
    // Fast path: not our offer's discount code → nothing to check.
    if !signals.cart_has_guarded_code {
        return ScoreResult {
            score: 0,
            decision: Decision::Allow,
            matched_signals: vec![],
        };
    }

    let mut score: u32 = 0;
    let mut matched: Vec<&'static str> = Vec::new();

    // -----------------------------------------------------------------------
    // Rule 4.1 — Phone exact
    // -----------------------------------------------------------------------
    if let Some(h) = signals.phone_hash {
        if set.phone_hashes.contains(&h) {
            score += W_PHONE_EXACT;
            matched.push("Phone matches a prior redemption");
        }
    }

    // -----------------------------------------------------------------------
    // Rules 4.2 / 4.3 — Email (exact OR fuzzy, strongest tier only)
    // -----------------------------------------------------------------------
    let mut email_matched = false;

    if let Some(h) = signals.email_hash {
        if set.email_hashes.contains(&h) {
            score += W_EMAIL_CANONICAL_EXACT;
            matched.push("Email matches a prior redemption");
            email_matched = true;
        }
    }

    if !email_matched {
        if let Some(ref sketch) = signals.email_sketch {
            let overlap = best_sketch_overlap(sketch, &set.email_sketches);
            match overlap {
                2..=4 => {
                    score += W_EMAIL_MINHASH_STRONG;
                    matched.push("Similar email to a prior redemption");
                }
                1 => {
                    score += W_EMAIL_MINHASH_WEAK;
                    matched.push("Loose email similarity");
                }
                _ => {}
            }
        }
    }

    // -----------------------------------------------------------------------
    // Rules 4.4 / 4.5 / 4.6 — Address (full > house > fuzzy, pick one)
    // -----------------------------------------------------------------------
    let mut addr_matched = false;

    if let Some(h) = signals.address_full_hash {
        if set.address_full_hashes.contains(&h) {
            score += W_ADDRESS_FULL_EXACT;
            matched.push("Address matches a prior redemption");
            addr_matched = true;
        }
    }

    if !addr_matched {
        if let Some(h) = signals.address_house_hash {
            if set.address_house_hashes.contains(&h) {
                score += W_ADDRESS_HOUSE_EXACT;
                matched.push("Address (same building) matches");
                addr_matched = true;
            }
        }
    }

    if !addr_matched {
        if let Some(ref sketch) = signals.address_sketch {
            let overlap = best_sketch_overlap(sketch, &set.address_sketches);
            match overlap {
                2..=4 => {
                    score += W_ADDRESS_MINHASH_STRONG;
                    matched.push("Similar address to a prior redemption");
                }
                1 => {
                    score += W_ADDRESS_MINHASH_WEAK;
                    matched.push("Loose address similarity");
                }
                _ => {}
            }
        }
    }

    // -----------------------------------------------------------------------
    // Rule 4.7 — Customer account tag
    // -----------------------------------------------------------------------
    if signals.customer_redeemed_tag {
        score += W_CUSTOMER_TAG;
        matched.push("Customer already redeemed this offer");
    }

    // -----------------------------------------------------------------------
    // Decision
    // -----------------------------------------------------------------------
    let decision = if score >= THRESHOLD_HIGH {
        Decision::Block
    } else if score >= THRESHOLD_MEDIUM {
        Decision::Review
    } else {
        Decision::Allow
    };

    ScoreResult {
        score,
        decision,
        matched_signals: matched,
    }
}
