/**
 * Auto-generated from docs/scoring-constants.json via scripts/generate-constants.ts.
 * Do not edit by hand. Edit the JSON and rerun.
 *
 * See: docs/scoring-spec.md §3
 */
export const SCORING_VERSION = 1;

export const THRESHOLD_MEDIUM = 4;
export const THRESHOLD_HIGH = 10;

export const WEIGHTS = {
  phone_exact: 10,
  email_canonical_exact: 10,
  email_minhash_strong: 6,
  email_minhash_weak: 4,
  address_full_exact: 10,
  address_house_exact: 8,
  address_minhash_strong: 6,
  address_minhash_weak: 4,
  customer_tag: 10,
  ip_v4_24: 2,
  ip_v6_48: 2,
} as const;
