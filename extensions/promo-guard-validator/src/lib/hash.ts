/**
 * FNV-1a 32-bit + tagged salted lookup hash. Mirrors `app/lib/hash.server.ts`
 * exactly so a hash computed at post-order time matches one computed at
 * checkout time. The two implementations must agree byte-for-byte.
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const HASH_SEP = 0x00;

function mulU32(a: number, b: number): number {
  return Math.imul(a | 0, b | 0) >>> 0;
}

export function fnv1a32(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS_32 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ bytes[i]) >>> 0;
    hash = mulU32(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

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

export function hashToHex(h: number): string {
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Decode a hex string into bytes. Returns empty array on odd-length input. */
export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(s.slice(i * 2, i * 2 + 1), 16);
    const lo = parseInt(s.slice(i * 2 + 1, i * 2 + 2), 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return new Uint8Array(0);
    out[i] = (hi << 4) | lo;
  }
  return out;
}
