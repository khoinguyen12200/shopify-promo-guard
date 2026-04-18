/**
 * See: docs/scoring-spec.md §3 (signal scoring), §5 (post-order)
 * Related: docs/normalization-spec.md §1–§3 (canonicalization)
 */

import { canonicalEmail } from "../normalize/email.server.js";
import { canonicalPhone } from "../normalize/phone.server.js";
import { fullKey, houseKey } from "../normalize/address.server.js";
import { hashForLookup, hashToHex } from "../hash.server.js";
import { jaccardEstimate } from "../minhash.server.js";
import {
  THRESHOLD_MEDIUM,
  THRESHOLD_HIGH,
  WEIGHTS,
} from "./constants.server.js";
import prisma from "../../db.server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderSignals {
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressZip?: string;
  addressCountry?: string;
  ip?: string;
  deviceFingerprint?: string;
}

export interface ScoreInput {
  shopSalt: string; // hex string from Shop model
  protectedOfferId: string;
  signals: OrderSignals;
  emailSketch?: number[];
  addressSketch?: number[];
}

export interface ScoreResult {
  score: number;
  decision: "allow" | "review" | "block";
  matchedSignals: string[];
  hashes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function saltBytes(shopSalt: string): Uint8Array {
  // shopSalt is a hex string — convert to bytes
  const bytes = new Uint8Array(shopSalt.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(shopSalt.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function lookupHash(tag: string, value: string, salt: Uint8Array): string {
  return hashToHex(hashForLookup(tag, toBytes(value), salt));
}

function decide(score: number): "allow" | "review" | "block" {
  if (score >= THRESHOLD_HIGH) return "block";
  if (score >= THRESHOLD_MEDIUM) return "review";
  return "allow";
}

// ---------------------------------------------------------------------------
// scorePostOrder — main export
// ---------------------------------------------------------------------------

/**
 * Score an order's identity signals against existing RedemptionRecords for the
 * given protected offer. Implements §5.2 (per-record max scoring).
 *
 * Returns a ScoreResult with the score, decision, matched signals, and the
 * computed hashes to be stored in the new RedemptionRecord.
 */
export async function scorePostOrder(input: ScoreInput): Promise<ScoreResult> {
  const { shopSalt, protectedOfferId, signals } = input;
  const salt = saltBytes(shopSalt);

  // ------------------------------------------------------------------
  // 1. Normalize signals + compute hashes
  // ------------------------------------------------------------------
  const hashes: Record<string, string> = {};
  const orClauses: object[] = [];

  // Email
  const canonEmail = signals.email ? canonicalEmail(signals.email) : null;
  if (canonEmail) {
    const h = lookupHash("email_canonical", canonEmail, salt);
    hashes["email_canonical"] = h;
    orClauses.push({ emailCanonicalHash: h });
  }

  // Phone
  const canonPhone = signals.phone
    ? canonicalPhone(signals.phone, null)
    : null;
  if (canonPhone) {
    const h = lookupHash("phone", canonPhone, salt);
    hashes["phone"] = h;
    orClauses.push({ phoneHash: h });
  }

  // Address
  const hasAddress =
    signals.addressLine1 || signals.addressZip || signals.addressCountry;
  let addrFullKey: string | null = null;
  let addrHouseKey: string | null = null;
  if (hasAddress) {
    const addrInput = {
      line1: signals.addressLine1 ?? "",
      line2: signals.addressLine2 ?? "",
      zip: signals.addressZip ?? "",
      countryCode: signals.addressCountry ?? "",
    };
    addrFullKey = fullKey(addrInput);
    addrHouseKey = houseKey(addrInput);
    const hFull = lookupHash("addr_full", addrFullKey, salt);
    const hHouse = lookupHash("addr_house", addrHouseKey, salt);
    hashes["address_full"] = hFull;
    hashes["address_house"] = hHouse;
    orClauses.push({ addressFullHash: hFull });
    // addr_house is not a separate DB column, but we include it in hashes
    // for storage. The full hash lookup covers building-level matches.
  }

  // IP (post-order only)
  if (signals.ip) {
    // Derive /24 key for IPv4: take first 3 octets
    const v4match = signals.ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    if (v4match) {
      const v4key = v4match[1];
      const h = lookupHash("ip_v4_24", v4key, salt);
      hashes["ip_v4_24"] = h;
      orClauses.push({ ipHash24: h });
    }
  }

  // Device fingerprint (stored as hash for future use, no DB column yet)
  if (signals.deviceFingerprint) {
    const h = lookupHash("device", signals.deviceFingerprint, salt);
    hashes["device"] = h;
  }

  // ------------------------------------------------------------------
  // 2. Query exact-match candidates
  // ------------------------------------------------------------------
  let candidates: {
    id: string;
    phoneHash: string | null;
    emailCanonicalHash: string | null;
    addressFullHash: string | null;
    ipHash24: string | null;
    emailMinhashSketch: string | null;
    addressMinhashSketch: string | null;
  }[] = [];

  if (orClauses.length > 0) {
    candidates = await prisma.redemptionRecord.findMany({
      where: {
        protectedOfferId,
        OR: orClauses,
      },
      select: {
        id: true,
        phoneHash: true,
        emailCanonicalHash: true,
        addressFullHash: true,
        ipHash24: true,
        emailMinhashSketch: true,
        addressMinhashSketch: true,
      },
      take: 5000,
    });
  }

  // For MinHash fuzzy matching, also pull recent records (up to 10k)
  // only when incoming sketches are provided.
  const allCandidates = [...candidates];
  if (input.emailSketch || input.addressSketch) {
    const recent = await prisma.redemptionRecord.findMany({
      where: { protectedOfferId },
      select: {
        id: true,
        phoneHash: true,
        emailCanonicalHash: true,
        addressFullHash: true,
        ipHash24: true,
        emailMinhashSketch: true,
        addressMinhashSketch: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10_000,
    });
    // Merge, deduplicate by id
    const seen = new Set(candidates.map((c) => c.id));
    for (const r of recent) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        allCandidates.push(r);
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Per-record scoring — pick the record that maximises score (§5.2)
  // ------------------------------------------------------------------
  let best: { score: number; matchedSignals: string[] } = {
    score: 0,
    matchedSignals: [],
  };

  for (const record of allCandidates) {
    let s = 0;
    const facts: string[] = [];

    // Rule 4.1 — Phone
    if (hashes["phone"] && record.phoneHash === hashes["phone"]) {
      s += WEIGHTS.phone_exact;
      facts.push("phone");
    }

    // Rule 4.2 / 4.3 — Email (exact or fuzzy; exact beats fuzzy)
    let emailMatched = false;
    if (
      hashes["email_canonical"] &&
      record.emailCanonicalHash === hashes["email_canonical"]
    ) {
      s += WEIGHTS.email_canonical_exact;
      facts.push("email_canonical");
      emailMatched = true;
    }
    if (!emailMatched && input.emailSketch && record.emailMinhashSketch) {
      const storedSketch = JSON.parse(record.emailMinhashSketch) as number[];
      const sim = jaccardEstimate(input.emailSketch, storedSketch);
      if (sim >= 0.5) {
        s += WEIGHTS.email_minhash_strong;
        facts.push("email_fuzzy_strong");
        emailMatched = true;
      } else if (sim >= 0.25) {
        s += WEIGHTS.email_minhash_weak;
        facts.push("email_fuzzy_weak");
        emailMatched = true;
      }
    }

    // Rule 4.4 / 4.5 / 4.6 — Address (full exact > house exact > fuzzy)
    let addrMatched = false;
    if (
      hashes["address_full"] &&
      record.addressFullHash === hashes["address_full"]
    ) {
      s += WEIGHTS.address_full_exact;
      facts.push("address_full");
      addrMatched = true;
    }
    // address_house: same DB column (addressFullHash stores addr_house hash too
    // when full is unavailable) — but per spec §4.5, house key has a different
    // tag so we check hashes["address_house"] against addressFullHash.
    // In practice the DB stores both in separate records or uses the full hash;
    // for MVP we check if the stored record's full-hash equals our house-hash.
    if (!addrMatched && hashes["address_house"] && record.addressFullHash) {
      if (record.addressFullHash === hashes["address_house"]) {
        s += WEIGHTS.address_house_exact;
        facts.push("address_house");
        addrMatched = true;
      }
    }
    if (!addrMatched && input.addressSketch && record.addressMinhashSketch) {
      const storedSketch = JSON.parse(
        record.addressMinhashSketch,
      ) as number[];
      const sim = jaccardEstimate(input.addressSketch, storedSketch);
      if (sim >= 0.5) {
        s += WEIGHTS.address_minhash_strong;
        facts.push("address_fuzzy_strong");
      } else if (sim >= 0.25) {
        s += WEIGHTS.address_minhash_weak;
        facts.push("address_fuzzy_weak");
      }
    }

    // Rule 4.8 — IP (post-order only)
    if (hashes["ip_v4_24"] && record.ipHash24 === hashes["ip_v4_24"]) {
      s += WEIGHTS.ip_v4_24;
      facts.push("ip_v4_24");
    }

    if (s > best.score) {
      best = { score: s, matchedSignals: facts };
    } else if (s === best.score && s > 0) {
      // Merge facts on tie
      const merged = new Set([...best.matchedSignals, ...facts]);
      best = { score: s, matchedSignals: Array.from(merged) };
    }
  }

  return {
    score: best.score,
    decision: decide(best.score),
    matchedSignals: best.matchedSignals,
    hashes,
  };
}
