//! Unit tests for checkout scoring.
//! See: docs/scoring-spec.md §4 and §9 (worked examples)
//!
//! See: docs/scoring-spec.md §4, §5.1, §8 (edge cases), §9 (worked examples)

use promo_guard_shared::scoring::checkout::{
    score_checkout, CheckoutSignals, Decision, RedemptionHashSet,
};
use promo_guard_shared::scoring::constants::{
    THRESHOLD_HIGH, THRESHOLD_MEDIUM, W_ADDRESS_FULL_EXACT, W_ADDRESS_HOUSE_EXACT,
    W_ADDRESS_MINHASH_STRONG, W_ADDRESS_MINHASH_WEAK, W_CUSTOMER_TAG, W_EMAIL_CANONICAL_EXACT,
    W_EMAIL_MINHASH_STRONG, W_EMAIL_MINHASH_WEAK, W_PHONE_EXACT,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn empty_set() -> RedemptionHashSet {
    RedemptionHashSet {
        email_hashes: vec![],
        phone_hashes: vec![],
        address_full_hashes: vec![],
        address_house_hashes: vec![],
        ip_hashes: vec![],
        device_hashes: vec![],
        email_sketches: vec![],
        address_sketches: vec![],
    }
}

fn guarded_signals() -> CheckoutSignals {
    CheckoutSignals {
        email_hash: None,
        phone_hash: None,
        address_full_hash: None,
        address_house_hash: None,
        ip_hash: None,
        device_hash: None,
        email_sketch: None,
        address_sketch: None,
        cart_has_guarded_code: true,
        customer_redeemed_tag: false,
    }
}

// ---------------------------------------------------------------------------
// Fast-path
// ---------------------------------------------------------------------------

#[test]
fn no_guarded_code_scores_zero_and_allows() {
    let signals = CheckoutSignals {
        cart_has_guarded_code: false,
        ..guarded_signals()
    };
    let result = score_checkout(&signals, &empty_set());
    assert_eq!(result.score, 0);
    assert_eq!(result.decision, Decision::Allow);
    assert!(result.matched_signals.is_empty());
}

// ---------------------------------------------------------------------------
// Empty ledger → score 0 → Allow  (scoring-spec.md §8 edge case)
// ---------------------------------------------------------------------------

#[test]
fn empty_set_scores_zero_and_allows() {
    let signals = CheckoutSignals {
        email_hash: Some(0xDEAD_BEEF),
        phone_hash: Some(0xCAFE_BABE),
        address_full_hash: Some(0x1234_5678),
        ..guarded_signals()
    };
    let result = score_checkout(&signals, &empty_set());
    assert_eq!(result.score, 0);
    assert_eq!(result.decision, Decision::Allow);
    assert!(result.matched_signals.is_empty());
}

// ---------------------------------------------------------------------------
// Individual signal weights
// ---------------------------------------------------------------------------

#[test]
fn phone_match_adds_correct_weight() {
    let h: u32 = 0xAAAA_AAAA;
    let signals = CheckoutSignals {
        phone_hash: Some(h),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        phone_hashes: vec![h],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_PHONE_EXACT);
    assert!(result.matched_signals.contains(&"Phone matches a prior redemption"));
}

#[test]
fn email_exact_match_adds_correct_weight() {
    let h: u32 = 0xBBBB_BBBB;
    let signals = CheckoutSignals {
        email_hash: Some(h),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_hashes: vec![h],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_EMAIL_CANONICAL_EXACT);
    assert!(result.matched_signals.contains(&"Email matches a prior redemption"));
}

#[test]
fn email_minhash_strong_match() {
    // 2 bands match → strong
    let incoming: [u32; 4] = [1, 2, 3, 4];
    let stored: [u32; 4] = [1, 2, 99, 99]; // 2 match
    let signals = CheckoutSignals {
        email_sketch: Some(incoming),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_sketches: vec![stored],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_EMAIL_MINHASH_STRONG);
    assert!(result.matched_signals.contains(&"Similar email to a prior redemption"));
}

#[test]
fn email_minhash_weak_match() {
    // exactly 1 band matches → weak
    let incoming: [u32; 4] = [1, 2, 3, 4];
    let stored: [u32; 4] = [1, 99, 99, 99];
    let signals = CheckoutSignals {
        email_sketch: Some(incoming),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_sketches: vec![stored],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_EMAIL_MINHASH_WEAK);
    assert!(result.matched_signals.contains(&"Loose email similarity"));
}

#[test]
fn address_full_exact_match() {
    let h: u32 = 0xCCCC_CCCC;
    let signals = CheckoutSignals {
        address_full_hash: Some(h),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        address_full_hashes: vec![h],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_ADDRESS_FULL_EXACT);
    assert!(result.matched_signals.contains(&"Address matches a prior redemption"));
}

#[test]
fn address_house_match_when_full_misses() {
    let h: u32 = 0xDDDD_DDDD;
    let signals = CheckoutSignals {
        address_full_hash: Some(0x0000_0001), // won't match
        address_house_hash: Some(h),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        address_house_hashes: vec![h],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_ADDRESS_HOUSE_EXACT);
    assert!(result.matched_signals.contains(&"Address (same building) matches"));
}

#[test]
fn address_minhash_strong_when_exact_misses() {
    let incoming: [u32; 4] = [10, 20, 30, 40];
    let stored: [u32; 4] = [10, 20, 99, 99]; // 2 match
    let signals = CheckoutSignals {
        address_sketch: Some(incoming),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        address_sketches: vec![stored],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_ADDRESS_MINHASH_STRONG);
    assert!(result.matched_signals.contains(&"Similar address to a prior redemption"));
}

#[test]
fn address_minhash_weak() {
    let incoming: [u32; 4] = [10, 20, 30, 40];
    let stored: [u32; 4] = [10, 99, 99, 99]; // 1 match
    let signals = CheckoutSignals {
        address_sketch: Some(incoming),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        address_sketches: vec![stored],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_ADDRESS_MINHASH_WEAK);
    assert!(result.matched_signals.contains(&"Loose address similarity"));
}

#[test]
fn customer_tag_adds_correct_weight() {
    let signals = CheckoutSignals {
        customer_redeemed_tag: true,
        ..guarded_signals()
    };
    let result = score_checkout(&signals, &empty_set());
    assert_eq!(result.score, W_CUSTOMER_TAG);
    assert!(result.matched_signals.contains(&"Customer already redeemed this offer"));
}

// ---------------------------------------------------------------------------
// Tier priority — exact beats fuzzy
// ---------------------------------------------------------------------------

#[test]
fn email_exact_wins_over_minhash() {
    let h: u32 = 0xEEEE_EEEE;
    // Both exact and sketch match; exact must win and minhash must not add more.
    let incoming_sketch: [u32; 4] = [1, 1, 1, 1];
    let signals = CheckoutSignals {
        email_hash: Some(h),
        email_sketch: Some(incoming_sketch),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_hashes: vec![h],
        email_sketches: vec![[1, 1, 1, 1]], // would be a strong match
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    // Only W_EMAIL_CANONICAL_EXACT, not W_EMAIL_CANONICAL_EXACT + W_EMAIL_MINHASH_STRONG
    assert_eq!(result.score, W_EMAIL_CANONICAL_EXACT);
    assert_eq!(result.matched_signals.len(), 1);
}

#[test]
fn address_full_exact_wins_over_house_and_fuzzy() {
    let full_h: u32 = 0xFF00_FF00;
    let house_h: u32 = 0x00FF_00FF;
    let sketch: [u32; 4] = [5, 5, 5, 5];
    let signals = CheckoutSignals {
        address_full_hash: Some(full_h),
        address_house_hash: Some(house_h),
        address_sketch: Some(sketch),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        address_full_hashes: vec![full_h],
        address_house_hashes: vec![house_h],
        address_sketches: vec![[5, 5, 5, 5]],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_ADDRESS_FULL_EXACT);
    assert_eq!(result.matched_signals.len(), 1);
}

// ---------------------------------------------------------------------------
// Multiple independent signals sum  (scoring-spec.md §5.1)
// ---------------------------------------------------------------------------

#[test]
fn phone_plus_email_plus_address_sum_correctly() {
    let ph: u32 = 0x1111_1111;
    let eh: u32 = 0x2222_2222;
    let ah: u32 = 0x3333_3333;
    let signals = CheckoutSignals {
        phone_hash: Some(ph),
        email_hash: Some(eh),
        address_full_hash: Some(ah),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        phone_hashes: vec![ph],
        email_hashes: vec![eh],
        address_full_hashes: vec![ah],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    let expected = W_PHONE_EXACT + W_EMAIL_CANONICAL_EXACT + W_ADDRESS_FULL_EXACT;
    assert_eq!(result.score, expected);
    assert_eq!(result.matched_signals.len(), 3);
}

// ---------------------------------------------------------------------------
// Decision thresholds (scoring-spec.md §3 + §6)
// "Score is exactly 4 or exactly 10" → threshold is >=
// ---------------------------------------------------------------------------

#[test]
fn score_below_medium_threshold_is_allow() {
    // W_EMAIL_MINHASH_WEAK = 4 but let's use an overlap-0 scenario
    // We need a score of 3, which doesn't map to any single weight.
    // Use customer_tag = false and no matches: score = 0 → Allow
    let result = score_checkout(&guarded_signals(), &empty_set());
    assert_eq!(result.decision, Decision::Allow);
}

#[test]
fn score_exactly_medium_threshold_is_review() {
    // W_EMAIL_MINHASH_WEAK == THRESHOLD_MEDIUM == 4
    assert_eq!(W_EMAIL_MINHASH_WEAK, THRESHOLD_MEDIUM);
    let incoming: [u32; 4] = [1, 2, 3, 4];
    let stored: [u32; 4] = [1, 99, 99, 99]; // 1 band → weak
    let signals = CheckoutSignals {
        email_sketch: Some(incoming),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_sketches: vec![stored],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, THRESHOLD_MEDIUM);
    assert_eq!(result.decision, Decision::Review);
}

#[test]
fn score_exactly_high_threshold_is_block() {
    // W_PHONE_EXACT == THRESHOLD_HIGH == 10
    assert_eq!(W_PHONE_EXACT, THRESHOLD_HIGH);
    let h: u32 = 0xAAAA_0000;
    let signals = CheckoutSignals {
        phone_hash: Some(h),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        phone_hashes: vec![h],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, THRESHOLD_HIGH);
    assert_eq!(result.decision, Decision::Block);
}

#[test]
fn score_above_high_threshold_is_still_block() {
    let ph: u32 = 0xAAAA_1111;
    let eh: u32 = 0xBBBB_2222;
    let signals = CheckoutSignals {
        phone_hash: Some(ph),
        email_hash: Some(eh),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        phone_hashes: vec![ph],
        email_hashes: vec![eh],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, W_PHONE_EXACT + W_EMAIL_CANONICAL_EXACT); // 20
    assert_eq!(result.decision, Decision::Block);
}

// ---------------------------------------------------------------------------
// Null / missing signals are skipped  (scoring-spec.md §8)
// ---------------------------------------------------------------------------

#[test]
fn none_phone_hash_is_skipped() {
    let signals = CheckoutSignals {
        phone_hash: None,
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        phone_hashes: vec![0xDEAD_BEEF],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, 0);
}

#[test]
fn none_email_hash_and_no_sketch_adds_nothing() {
    let signals = CheckoutSignals {
        email_hash: None,
        email_sketch: None,
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_hashes: vec![0x1234_5678],
        email_sketches: vec![[1, 1, 1, 1]],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    assert_eq!(result.score, 0);
}

// ---------------------------------------------------------------------------
// best_sketch_overlap picks the best across multiple stored sketches
// ---------------------------------------------------------------------------

#[test]
fn minhash_picks_best_match_from_multiple_sketches() {
    let incoming: [u32; 4] = [7, 8, 9, 10];
    let stored_weak: [u32; 4] = [7, 99, 99, 99]; // 1 match
    let stored_strong: [u32; 4] = [7, 8, 99, 99]; // 2 matches
    let signals = CheckoutSignals {
        email_sketch: Some(incoming),
        ..guarded_signals()
    };
    let set = RedemptionHashSet {
        email_sketches: vec![stored_weak, stored_strong],
        ..empty_set()
    };
    let result = score_checkout(&signals, &set);
    // Should pick the strong match
    assert_eq!(result.score, W_EMAIL_MINHASH_STRONG);
}
