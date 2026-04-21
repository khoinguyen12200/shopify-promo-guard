import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";
import { hashForLookup, hashToHex } from "./lib/hash";
import {
  canonicalEmail,
  canonicalPhone,
  fullKey,
  houseKey,
} from "./lib/normalize";
import { parseShard } from "./lib/shard";
import {
  scoreOffer,
  THRESHOLD_HIGH,
  type CheckoutSignals,
} from "./lib/scoring";

/**
 * Score the buyer's signals against every protected offer's bucket
 * independently and emit a ValidationError for each offer that is in `block`
 * mode AND scores ≥ THRESHOLD_HIGH. `watch`-mode offers never block — they're
 * still evaluated post-order via the orders/paid handler, so the merchant can
 * review flagged orders from watch mode without disrupting checkout.
 *
 * Per-offer segmentation is required for correctness: a buyer who redeemed
 * offer A should still be able to redeem a different offer B for the first
 * time. See docs/function-queries-spec.md §9.
 */
export function cartValidationsGenerateRun(
  input: CartValidationsGenerateRunInput,
): CartValidationsGenerateRunResult {
  const shard = parseShard(input.shop.shard?.jsonValue);
  const offers = shard.offers;

  // Empty shard / no offers configured → nothing to score against. Allow.
  const offerIds = Object.keys(offers);
  if (offerIds.length === 0) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const buyer = input.cart.buyerIdentity;
  const customerRedeemedTag = buyer?.customer?.hasAnyTag === true;

  const salt = shard.salt;
  const cc = shard.defaultCountryCc;

  // Hash each available signal once; reuse across every offer's scoring pass.
  const phoneCanon = canonicalPhone(buyer?.phone ?? null, cc);
  const phoneHash = phoneCanon
    ? hashToHex(hashForLookup("phone", encode(phoneCanon), salt))
    : null;

  const emailCanon = canonicalEmail(buyer?.email ?? null);
  const emailHash = emailCanon
    ? hashToHex(hashForLookup("email_canonical", encode(emailCanon), salt))
    : null;

  // Address — use the first delivery group with a usable address.
  let addressFullHash: string | null = null;
  let addressHouseHash: string | null = null;
  for (const group of input.cart.deliveryGroups) {
    const addr = group.deliveryAddress;
    if (!addr) continue;
    const addressInput = {
      line1: addr.address1 ?? "",
      line2: addr.address2 ?? "",
      zip: addr.zip ?? "",
      countryCode: (addr.countryCode as string | null) ?? "",
    };
    addressFullHash = hashToHex(
      hashForLookup("addr_full", encode(fullKey(addressInput)), salt),
    );
    addressHouseHash = hashToHex(
      hashForLookup("addr_house", encode(houseKey(addressInput)), salt),
    );
    break;
  }

  const signals: CheckoutSignals = {
    phoneHash,
    emailHash,
    addressFullHash,
    addressHouseHash,
    customerRedeemedTag,
  };

  const errors: ValidationError[] = [];
  for (const offerId of offerIds) {
    const bucket = offers[offerId];
    const score = scoreOffer(signals, bucket);
    if (score >= THRESHOLD_HIGH && bucket.mode === "block") {
      errors.push({
        message: "This offer has already been used.",
        target: "$.cart",
      });
    }
  }

  return { operations: [{ validationAdd: { errors } }] };
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
