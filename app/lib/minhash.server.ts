/**
 * See: docs/normalization-spec.md §6 (MinHash bottom-K)
 */

import { fnv1aSalted } from "./hash.server";

/** Number of bottom-K values retained in each sketch. */
const K = 4;
const PAD = 0xffffffff;

/**
 * Compute a bottom-K MinHash sketch for a set of trigrams.
 *
 * For each trigram: hash = fnv1a_salted(salt, trigramBytes).
 * Sort all hashes ascending, take the K=4 smallest.
 * Pad with 0xffffffff when there are fewer than K trigrams.
 *
 * @param trigrams  Array of 3-byte UTF-8 strings (duplicates are de-duped).
 * @param salt      Shop salt bytes fed into fnv1a_salted.
 * @returns         Array of exactly 4 unsigned 32-bit integers.
 */
export function computeSketch(trigrams: string[], salt: Uint8Array): number[] {
  const enc = new TextEncoder();
  const unique = [...new Set(trigrams)];
  const hashes = unique.map((t) => fnv1aSalted(salt, enc.encode(t)));
  hashes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = hashes.slice(0, K);
  while (result.length < K) result.push(PAD);
  return result;
}

/**
 * Estimate Jaccard similarity between two K=4 MinHash sketches.
 *
 * Algorithm (spec §6):
 *   union = set(a) | set(b), take 4 smallest values
 *   intersection_count = how many of those 4 smallest appear in BOTH a and b
 *   return intersection_count / 4
 *
 * Result is always one of {0.0, 0.25, 0.5, 0.75, 1.0}.
 */
export function jaccardEstimate(a: number[], b: number[]): number {
  const union = [...new Set([...a, ...b])];
  union.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const smallest4 = union.slice(0, K);
  const setA = new Set(a);
  const setB = new Set(b);
  const intersectionCount = smallest4.filter(
    (v) => setA.has(v) && setB.has(v),
  ).length;
  return intersectionCount / K;
}

/**
 * Returns true when the Jaccard estimate of the two sketches meets or exceeds
 * the given threshold.
 */
export function hasSufficientOverlap(
  a: number[],
  b: number[],
  threshold: number,
): boolean {
  return jaccardEstimate(a, b) >= threshold;
}
