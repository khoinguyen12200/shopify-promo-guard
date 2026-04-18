//! Hashing primitives (FNV-1a 32-bit, salted tag hashing).
//!
//! See: docs/normalization-spec.md §5 (FNV-1a), §7 (salted tagged hashing)
//! Fixture: docs/test-fixtures/hash-vectors.json

use crate::constants::{FNV_OFFSET_BASIS_32, FNV_PRIME_32, HASH_SEP};

/// FNV-1a 32-bit hash.
///
/// Iterate bytes: XOR into the accumulator, then multiply by the prime with
/// wrapping u32 arithmetic. See docs/normalization-spec.md §5.
#[inline]
pub fn fnv1a_32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = FNV_OFFSET_BASIS_32;
    for &b in bytes {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME_32);
    }
    hash
}

/// FNV-1a 32-bit over the byte concatenation `salt ++ input` (no separator).
/// See docs/normalization-spec.md §7.
#[inline]
pub fn fnv1a_salted(salt: &[u8], input: &[u8]) -> u32 {
    let mut hash: u32 = FNV_OFFSET_BASIS_32;
    for &b in salt {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME_32);
    }
    for &b in input {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME_32);
    }
    hash
}

/// Tagged salted hash used for metafield lookup keys:
/// `fnv1a_32(shop_salt ++ 0x00 ++ signal_tag ++ 0x00 ++ normalized_value)`.
///
/// See docs/normalization-spec.md §7.
#[inline]
pub fn hash_for_lookup(signal_tag: &str, normalized_value: &[u8], shop_salt: &[u8]) -> u32 {
    let mut hash: u32 = FNV_OFFSET_BASIS_32;
    for &b in shop_salt {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME_32);
    }
    hash ^= HASH_SEP as u32;
    hash = hash.wrapping_mul(FNV_PRIME_32);
    for &b in signal_tag.as_bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME_32);
    }
    hash ^= HASH_SEP as u32;
    hash = hash.wrapping_mul(FNV_PRIME_32);
    for &b in normalized_value {
        hash ^= b as u32;
        hash = hash.wrapping_mul(FNV_PRIME_32);
    }
    hash
}

/// Lowercase zero-padded 8-char hex rendering of a u32 hash.
#[inline]
pub fn hash_to_hex(h: u32) -> String {
    format!("{:08x}", h)
}
