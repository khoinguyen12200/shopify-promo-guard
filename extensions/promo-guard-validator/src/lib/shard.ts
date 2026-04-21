/**
 * Parse the v2 shop-wide shard JSON written by `app/lib/shards.server.ts`.
 * Tolerates missing/malformed entries per-row (a single bad hash never takes
 * the shop offline). Unknown shard versions return an empty shard so scoring
 * fall-throughs to "allow".
 */

import { hexToBytes } from "./hash";
import type { OfferBucket } from "./scoring";

export interface ParsedShard {
  salt: Uint8Array;
  defaultCountryCc: string | null;
  offers: Record<string, OfferBucket>;
}

const HEX8 = /^[0-9a-fA-F]{8}$/;

function parseHashSet(v: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(v)) return out;
  for (const x of v) {
    if (typeof x === "string" && HEX8.test(x)) out.add(x.toLowerCase());
  }
  return out;
}

function parseMode(v: unknown): "block" | "watch" {
  return v === "watch" ? "watch" : "block";
}

function parseBucket(v: unknown): OfferBucket {
  const obj =
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    mode: parseMode(obj.mode),
    phoneHashes: parseHashSet(obj.phone_hashes),
    emailHashes: parseHashSet(obj.email_hashes),
    addressFullHashes: parseHashSet(obj.address_full_hashes),
    addressHouseHashes: parseHashSet(obj.address_house_hashes),
  };
}

const EMPTY: ParsedShard = {
  salt: new Uint8Array(0),
  defaultCountryCc: null,
  offers: {},
};

export function parseShard(raw: unknown): ParsedShard {
  if (!raw || typeof raw !== "object") return EMPTY;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 2) return EMPTY;

  const saltHex = typeof obj.salt_hex === "string" ? obj.salt_hex : "";
  const cc =
    typeof obj.default_country_cc === "string"
      ? obj.default_country_cc
      : null;

  const offers: Record<string, OfferBucket> = {};
  if (obj.offers && typeof obj.offers === "object") {
    for (const [offerId, bucketRaw] of Object.entries(
      obj.offers as Record<string, unknown>,
    )) {
      if (!offerId) continue;
      offers[offerId] = parseBucket(bucketRaw);
    }
  }

  return {
    salt: hexToBytes(saltHex),
    defaultCountryCc: cc,
    offers,
  };
}
