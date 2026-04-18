/**
 * See: docs/normalization-spec.md §5, §7
 * Fixture: docs/test-fixtures/hash-vectors.json
 *
 * Node port of shared-rust/src/hash.rs. Parity is enforced by
 * scripts/verify-fixtures.ts + shared-rust/tests/fixture_vectors.rs, both
 * reading the same JSON fixture.
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const HASH_SEP = 0x00;

// Math.imul does signed 32-bit multiplication with wraparound; `>>> 0`
// reinterprets the result as an unsigned 32-bit integer. This is the standard
// idiom for emulating Rust's `u32::wrapping_mul` in JavaScript numbers.
function mulU32(a: number, b: number): number {
  return Math.imul(a | 0, b | 0) >>> 0;
}

/**
 * FNV-1a 32-bit hash of the input bytes.
 * Iterate bytes: XOR into the accumulator, then wrapping-multiply by the prime.
 */
export function fnv1a32(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS_32 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ bytes[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * FNV-1a 32-bit of `salt ++ input` (byte concatenation, no separator).
 */
export function fnv1aSalted(salt: Uint8Array, input: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS_32 >>> 0;
  for (let i = 0; i < salt.length; i++) {
    hash = (hash ^ salt[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ input[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * Tagged salted lookup hash:
 *   fnv1a_32(shop_salt ++ 0x00 ++ signal_tag ++ 0x00 ++ normalized_value)
 */
export function hashForLookup(
  tag: string,
  value: Uint8Array,
  shopSalt: Uint8Array,
): number {
  const tagBytes = new TextEncoder().encode(tag);
  let hash = FNV_OFFSET_BASIS_32 >>> 0;
  for (let i = 0; i < shopSalt.length; i++) {
    hash = (hash ^ shopSalt[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  hash = (hash ^ HASH_SEP) >>> 0;
  hash = mulU32(hash, FNV_PRIME_32);
  for (let i = 0; i < tagBytes.length; i++) {
    hash = (hash ^ tagBytes[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  hash = (hash ^ HASH_SEP) >>> 0;
  hash = mulU32(hash, FNV_PRIME_32);
  for (let i = 0; i < value.length; i++) {
    hash = (hash ^ value[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/** Lowercase zero-padded 8-char hex rendering of a u32 hash. */
export function hashToHex(h: number): string {
  return (h >>> 0).toString(16).padStart(8, "0");
}
