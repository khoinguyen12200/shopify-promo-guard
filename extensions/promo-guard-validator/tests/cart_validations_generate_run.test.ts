/**
 * Unit tests for the per-offer scoring in cartValidationsGenerateRun.
 *
 * Each test constructs a synthetic v2 shard JSON (the same shape `app/lib/
 * shards.server.ts` writes) plus a cart payload, then asserts whether the
 * function emits a ValidationError or allows the checkout.
 *
 * The CRITICAL invariant under test: a buyer matching offer A's ledger must
 * NOT be blocked when redeeming a different offer B for the first time.
 */
import { describe, expect, it } from "vitest";

import type {
  CartValidationsGenerateRunInput,
} from "../generated/api";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";
import { hashForLookup, hashToHex } from "../src/lib/hash";
import { canonicalEmail, canonicalPhone } from "../src/lib/normalize";

const SALT_HEX = "deadbeefcafef00d11223344aabbccdd";
const SALT_BYTES = (() => {
  const out = new Uint8Array(SALT_HEX.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(SALT_HEX.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
})();

function hashPhone(raw: string): string {
  const c = canonicalPhone(raw, "+1")!;
  return hashToHex(hashForLookup("phone", new TextEncoder().encode(c), SALT_BYTES));
}
function hashEmail(raw: string): string {
  const c = canonicalEmail(raw)!;
  return hashToHex(
    hashForLookup("email_canonical", new TextEncoder().encode(c), SALT_BYTES),
  );
}

function shardWithOffers(
  offers: Record<
    string,
    {
      mode: "block" | "watch";
      phones?: string[];
      emails?: string[];
    }
  >,
): unknown {
  const built: Record<string, unknown> = {};
  for (const [id, b] of Object.entries(offers)) {
    built[id] = {
      mode: b.mode,
      entry_ts: [],
      phone_hashes: b.phones ?? [],
      email_hashes: b.emails ?? [],
      address_full_hashes: [],
      address_house_hashes: [],
      ip_hashes: [],
      device_hashes: [],
      email_sketches: [],
      address_sketches: [],
    };
  }
  return {
    v: 2,
    salt_hex: SALT_HEX,
    default_country_cc: "+1",
    offers: built,
  };
}

function input(opts: {
  email?: string | null;
  phone?: string | null;
  hasAnyTag?: boolean;
  shardJson: unknown;
}): CartValidationsGenerateRunInput {
  return {
    cart: {
      buyerIdentity: {
        email: opts.email ?? null,
        phone: opts.phone ?? null,
        customer:
          opts.hasAnyTag != null ? { hasAnyTag: opts.hasAnyTag } : null,
      },
      deliveryGroups: [],
    },
    shop: {
      shard: opts.shardJson ? { jsonValue: opts.shardJson } : null,
    },
  } as unknown as CartValidationsGenerateRunInput;
}

function errorCount(result: ReturnType<typeof cartValidationsGenerateRun>): number {
  const op = result.operations[0];
  if (!op || !("validationAdd" in op) || !op.validationAdd) return 0;
  return op.validationAdd.errors.length;
}

describe("cartValidationsGenerateRun", () => {
  it("allows checkout when shard is missing or empty", () => {
    const result = cartValidationsGenerateRun(input({ shardJson: null }));
    expect(errorCount(result)).toBe(0);
  });

  it("allows checkout when no offer buckets exist", () => {
    const result = cartValidationsGenerateRun(
      input({ shardJson: shardWithOffers({}) }),
    );
    expect(errorCount(result)).toBe(0);
  });

  it("blocks when a phone hash matches a block-mode offer", () => {
    const phone = "+14155551212";
    const shard = shardWithOffers({
      offerA: { mode: "block", phones: [hashPhone(phone)] },
    });
    const result = cartValidationsGenerateRun(input({ phone, shardJson: shard }));
    expect(errorCount(result)).toBe(1);
  });

  it("does NOT block when the matching offer is in watch mode", () => {
    const phone = "+14155551212";
    const shard = shardWithOffers({
      offerA: { mode: "watch", phones: [hashPhone(phone)] },
    });
    const result = cartValidationsGenerateRun(input({ phone, shardJson: shard }));
    expect(errorCount(result)).toBe(0);
  });

  it("isolates offers — matching offer A does not block on offer B", () => {
    // The bug-fixing case the per-offer shard exists for: a buyer who used
    // offer A's discount last time should be allowed when redeeming offer B
    // for the first time.
    const phone = "+14155551212";
    const shard = shardWithOffers({
      offerA: { mode: "block", phones: [hashPhone(phone)] },
      offerB: { mode: "block", phones: [] }, // no prior redemptions
    });
    // Buyer matches offerA's ledger; offerB's bucket is empty → no block
    // should be emitted from offerB. (offerA still blocks once.)
    const result = cartValidationsGenerateRun(input({ phone, shardJson: shard }));
    expect(errorCount(result)).toBe(1);
  });

  it("emits one error per matched block-mode offer", () => {
    const phone = "+14155551212";
    const shard = shardWithOffers({
      offerA: { mode: "block", phones: [hashPhone(phone)] },
      offerB: { mode: "block", phones: [hashPhone(phone)] },
    });
    const result = cartValidationsGenerateRun(input({ phone, shardJson: shard }));
    expect(errorCount(result)).toBe(2);
  });

  it("matches both phone and email when both signals are present", () => {
    const phone = "+14155551212";
    const email = "alice@example.com";
    const shard = shardWithOffers({
      offerA: {
        mode: "block",
        phones: [hashPhone(phone)],
        emails: [hashEmail(email)],
      },
    });
    const result = cartValidationsGenerateRun(
      input({ phone, email, shardJson: shard }),
    );
    expect(errorCount(result)).toBe(1);
  });

  it("customer-tag rule alone (W=10) crosses HIGH threshold", () => {
    const shard = shardWithOffers({
      offerA: { mode: "block", phones: [] },
    });
    const result = cartValidationsGenerateRun(
      input({ hasAnyTag: true, shardJson: shard }),
    );
    expect(errorCount(result)).toBe(1);
  });

  it("phone miss against an unrelated hash → allow", () => {
    const phone = "+14155551212";
    // Random non-matching hex.
    const shard = shardWithOffers({
      offerA: { mode: "block", phones: ["00112233"] },
    });
    const result = cartValidationsGenerateRun(input({ phone, shardJson: shard }));
    expect(errorCount(result)).toBe(0);
  });

  it("rejects unknown shard versions (v1) and falls open", () => {
    const v1Shard = {
      v: 1,
      salt_hex: SALT_HEX,
      phone_hashes: [hashPhone("+14155551212")],
    };
    const result = cartValidationsGenerateRun(
      input({ phone: "+14155551212", shardJson: v1Shard }),
    );
    expect(errorCount(result)).toBe(0);
  });
});
