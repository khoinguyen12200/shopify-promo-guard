/**
 * Per-offer scoring at checkout. The validator iterates every offer in the
 * shard, computes a score against that offer's bucket, and decides whether
 * to emit a ValidationError based on the bucket's mode.
 *
 * Mirrors the post-order scorer in `app/lib/scoring/score.server.ts` for the
 * subset of signals available at checkout (no MinHash — see normalize.ts).
 */

export const THRESHOLD_HIGH = 10;

export const W_PHONE_EXACT = 10;
export const W_EMAIL_EXACT = 10;
export const W_ADDRESS_FULL_EXACT = 10;
export const W_ADDRESS_HOUSE_EXACT = 8;
export const W_CUSTOMER_TAG = 10;

export interface CheckoutSignals {
  /** 8-char hex u32 hash, or null if not derivable. */
  phoneHash: string | null;
  emailHash: string | null;
  addressFullHash: string | null;
  addressHouseHash: string | null;
  /** Customer is tagged "promo-guard-redeemed" — they've redeemed before on this shop. */
  customerRedeemedTag: boolean;
}

export interface OfferBucket {
  mode: "block" | "watch";
  phoneHashes: Set<string>;
  emailHashes: Set<string>;
  addressFullHashes: Set<string>;
  addressHouseHashes: Set<string>;
}

/**
 * Score the buyer's signals against this offer's hash bucket. Each matching
 * exact signal adds its weight. Customer tag adds W_CUSTOMER_TAG once, scoped
 * to "block" buckets only — a watch-mode offer that matches the tag still
 * counts the tag toward its score (but the validator suppresses the error).
 */
export function scoreOffer(
  signals: CheckoutSignals,
  bucket: OfferBucket,
): number {
  let score = 0;

  if (signals.phoneHash && bucket.phoneHashes.has(signals.phoneHash)) {
    score += W_PHONE_EXACT;
  }
  if (signals.emailHash && bucket.emailHashes.has(signals.emailHash)) {
    score += W_EMAIL_EXACT;
  }
  if (
    signals.addressFullHash &&
    bucket.addressFullHashes.has(signals.addressFullHash)
  ) {
    score += W_ADDRESS_FULL_EXACT;
  } else if (
    signals.addressHouseHash &&
    bucket.addressHouseHashes.has(signals.addressHouseHash)
  ) {
    // Only credit the weaker house key when the strict full-key didn't already
    // fire — avoids double-counting on the same address.
    score += W_ADDRESS_HOUSE_EXACT;
  }

  // Customer-tag rule: if this buyer is logged-in and tagged as a prior
  // redeemer on this shop, weight the score regardless of which offer they're
  // attempting now. The post-order scorer already counts this; we mirror it.
  if (signals.customerRedeemedTag) {
    score += W_CUSTOMER_TAG;
  }

  return score;
}
