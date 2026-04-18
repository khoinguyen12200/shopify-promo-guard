//! MinHash bottom-K sketch (K=4) over salted FNV-1a trigram hashes.
//!
//! See: docs/normalization-spec.md §6 (MinHash bottom-K)

use crate::hash::fnv1a_salted;

/// Number of bottom-K values retained in each sketch.
pub const K: usize = 4;

/// Sentinel pad value (u32::MAX) used when fewer than K trigrams are available.
pub const PAD: u32 = 0xffffffff;

/// Compute a bottom-K MinHash sketch for a collection of trigrams.
///
/// For each trigram byte slice: `fnv1a_salted(salt, trigram)`.
/// Sort the resulting hashes ascending and keep the K=4 smallest.
/// If fewer than K trigrams are provided, pad with `0xffffffff`.
///
/// # Arguments
/// * `trigrams` – slice of 3-byte arrays (duplicates are de-duped internally)
/// * `salt`     – shop salt bytes passed as the first argument to `fnv1a_salted`
pub fn compute_sketch(trigrams: &[[u8; 3]], salt: &[u8]) -> [u32; 4] {
    // De-duplicate
    let mut unique: Vec<[u8; 3]> = trigrams.to_vec();
    unique.sort_unstable();
    unique.dedup();

    let mut hashes: Vec<u32> = unique
        .iter()
        .map(|t| fnv1a_salted(salt, t.as_slice()))
        .collect();

    hashes.sort_unstable();

    let mut sketch = [PAD; 4];
    for (i, &h) in hashes.iter().take(K).enumerate() {
        sketch[i] = h;
    }
    sketch
}

/// Estimate Jaccard similarity between two K=4 MinHash sketches.
///
/// Algorithm (spec §6):
///   union = set(a) | set(b), take 4 smallest values
///   intersection_count = how many of those 4 smallest appear in BOTH a and b
///   return intersection_count / 4.0
///
/// Returns a value in `{0.0, 0.25, 0.5, 0.75, 1.0}`.
pub fn jaccard_estimate(a: &[u32; 4], b: &[u32; 4]) -> f32 {
    // Build sorted union (up to 8 values), deduplicated
    let mut union: Vec<u32> = Vec::with_capacity(8);
    union.extend_from_slice(a.as_slice());
    union.extend_from_slice(b.as_slice());
    union.sort_unstable();
    union.dedup();

    let smallest4 = &union[..union.len().min(K)];

    let set_a: std::collections::HashSet<u32> = a.iter().copied().collect();
    let set_b: std::collections::HashSet<u32> = b.iter().copied().collect();

    let intersection_count = smallest4
        .iter()
        .filter(|v| set_a.contains(v) && set_b.contains(v))
        .count();

    intersection_count as f32 / K as f32
}

/// Returns true when the Jaccard estimate meets or exceeds `threshold`.
pub fn has_sufficient_overlap(a: &[u32; 4], b: &[u32; 4], threshold: f32) -> bool {
    jaccard_estimate(a, b) >= threshold
}
