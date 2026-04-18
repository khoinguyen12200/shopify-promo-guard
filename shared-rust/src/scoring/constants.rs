//! Auto-generated from docs/scoring-constants.json via scripts/generate-constants.ts.
//! Do not edit by hand. Edit the JSON and rerun.
//!
//! See: docs/scoring-spec.md §3

pub const SCORING_VERSION: u32 = 1;

pub const THRESHOLD_MEDIUM: u32 = 4;
pub const THRESHOLD_HIGH: u32 = 10;

pub const W_PHONE_EXACT: u32 = 10;
pub const W_EMAIL_CANONICAL_EXACT: u32 = 10;
pub const W_EMAIL_MINHASH_STRONG: u32 = 6;
pub const W_EMAIL_MINHASH_WEAK: u32 = 4;
pub const W_ADDRESS_FULL_EXACT: u32 = 10;
pub const W_ADDRESS_HOUSE_EXACT: u32 = 8;
pub const W_ADDRESS_MINHASH_STRONG: u32 = 6;
pub const W_ADDRESS_MINHASH_WEAK: u32 = 4;
pub const W_CUSTOMER_TAG: u32 = 10;
pub const W_IP_V4_24: u32 = 2;
pub const W_IP_V6_48: u32 = 2;
