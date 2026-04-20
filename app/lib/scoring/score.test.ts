/**
 * See: docs/scoring-spec.md §3 (signal scoring), §5 (post-order)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScoreInput } from "./score.server";

// ---------------------------------------------------------------------------
// Mock Prisma before importing the module under test
// ---------------------------------------------------------------------------
const mockFindMany = vi.fn();

vi.mock("../../db.server.js", () => ({
  default: {
    redemptionRecord: {
      findMany: mockFindMany,
    },
  },
}));

// Import after mock is set up
const { scorePostOrder } = await import("./score.server.js");

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------
const SHOP_SALT = "deadbeef"; // 4-byte hex salt for tests
const OFFER_ID = "offer_abc123";

function baseInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    shopSalt: SHOP_SALT,
    protectedOfferId: OFFER_ID,
    signals: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scorePostOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no prior redemptions
    mockFindMany.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // Case 1 — no prior redemptions → allow
  // -------------------------------------------------------------------------
  it("returns score 0 and decision=allow when no redemption records exist", async () => {
    const result = await scorePostOrder(
      baseInput({
        signals: {
          email: "buyer@example.com",
          phone: "+14155552671",
        },
      }),
    );

    expect(result.score).toBe(0);
    expect(result.decision).toBe("allow");
    expect(result.matchedSignals).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Case 2 — email exact match → score 10 → block
  // -------------------------------------------------------------------------
  it("scores email_canonical_exact at weight 10 (→ block)", async () => {
    // We need to know what hash our scorer will compute for this email so we
    // can return a matching record. The scorer uses hashForLookup internally.
    // Instead of recomputing the hash here, we capture it from the `hashes`
    // field of a first call with no prior records, then replay it in the mock.
    const probe = await scorePostOrder(
      baseInput({ signals: { email: "buyer@gmail.com" } }),
    );
    const emailHash = probe.hashes["email_canonical"];
    expect(emailHash).toBeDefined();

    // Now mock a record that matches the computed hash
    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: emailHash,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({ signals: { email: "buyer@gmail.com" } }),
    );

    expect(result.score).toBe(10);
    expect(result.decision).toBe("block");
    expect(result.matchedSignals).toContain("email_canonical");
  });

  // -------------------------------------------------------------------------
  // Case 3 — phone exact match → score 10 → block
  // -------------------------------------------------------------------------
  it("scores phone_exact at weight 10 (→ block)", async () => {
    const probe = await scorePostOrder(
      baseInput({ signals: { phone: "+14155552671" } }),
    );
    const phoneHash = probe.hashes["phone"];
    expect(phoneHash).toBeDefined();

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({ signals: { phone: "+14155552671" } }),
    );

    expect(result.score).toBe(10);
    expect(result.decision).toBe("block");
    expect(result.matchedSignals).toContain("phone");
  });

  // -------------------------------------------------------------------------
  // Case 4 — address full exact → score 10 → block
  // -------------------------------------------------------------------------
  it("scores address_full_exact at weight 10 (→ block)", async () => {
    const probe = await scorePostOrder(
      baseInput({
        signals: {
          addressLine1: "123 Main St",
          addressLine2: "",
          addressZip: "94102",
          addressCountry: "US",
        },
      }),
    );
    const addrHash = probe.hashes["address_full"];
    expect(addrHash).toBeDefined();

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: addrHash,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({
        signals: {
          addressLine1: "123 Main St",
          addressLine2: "",
          addressZip: "94102",
          addressCountry: "US",
        },
      }),
    );

    expect(result.score).toBe(10);
    expect(result.decision).toBe("block");
    expect(result.matchedSignals).toContain("address_full");
  });

  // -------------------------------------------------------------------------
  // Case 5 — email + phone match on same record → score 20 → block
  // -------------------------------------------------------------------------
  it("sums weights when multiple signals match the same record", async () => {
    const probe = await scorePostOrder(
      baseInput({
        signals: { email: "multi@example.com", phone: "+14155559999" },
      }),
    );
    const emailHash = probe.hashes["email_canonical"];
    const phoneHash = probe.hashes["phone"];

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash,
        emailCanonicalHash: emailHash,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({
        signals: { email: "multi@example.com", phone: "+14155559999" },
      }),
    );

    expect(result.score).toBe(20); // phone(10) + email(10)
    expect(result.decision).toBe("block");
    expect(result.matchedSignals).toContain("phone");
    expect(result.matchedSignals).toContain("email_canonical");
  });

  // -------------------------------------------------------------------------
  // Case 6 — IP /24 only → score 2 → allow (below THRESHOLD_MEDIUM=4)
  // -------------------------------------------------------------------------
  it("scores ip_v4_24 at weight 2 and returns allow when score < 4", async () => {
    const probe = await scorePostOrder(
      baseInput({ signals: { ip: "192.168.1.100" } }),
    );
    const ipHash = probe.hashes["ip_v4_24"];
    expect(ipHash).toBeDefined();

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: ipHash,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({ signals: { ip: "192.168.1.100" } }),
    );

    expect(result.score).toBe(2);
    expect(result.decision).toBe("allow");
    expect(result.matchedSignals).toContain("ip_v4_24");
  });

  // -------------------------------------------------------------------------
  // Case 7 — score exactly 4 → review (THRESHOLD_MEDIUM boundary)
  // -------------------------------------------------------------------------
  it("maps score=4 to decision=review (THRESHOLD_MEDIUM boundary)", async () => {
    // IP(2) + IP(2) won't work — same record. Use email_fuzzy_weak (4) instead.
    const emailSketch = [1, 2, 3, 4]; // incoming sketch
    const storedSketch = [1, 99, 99, 99]; // 1 band overlap → weak (score 4)

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: JSON.stringify(storedSketch),
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({ emailSketch }),
    );

    expect(result.score).toBe(4);
    expect(result.decision).toBe("review");
    expect(result.matchedSignals).toContain("email_fuzzy_weak");
  });

  // -------------------------------------------------------------------------
  // Case 8 — score above HIGH (≥10) → block
  // -------------------------------------------------------------------------
  it("maps score>=10 to decision=block", async () => {
    const probe = await scorePostOrder(
      baseInput({ signals: { phone: "+14155550001" } }),
    );
    const phoneHash = probe.hashes["phone"];

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({ signals: { phone: "+14155550001" } }),
    );

    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.decision).toBe("block");
  });

  // -------------------------------------------------------------------------
  // Case 9 — email fuzzy strong match → score 6 → review
  // -------------------------------------------------------------------------
  it("scores email_minhash_strong at weight 6 (→ review)", async () => {
    const emailSketch = [10, 20, 30, 40];
    const storedSketch = [10, 20, 99, 99]; // 2 band overlap → strong

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: JSON.stringify(storedSketch),
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(baseInput({ emailSketch }));

    expect(result.score).toBe(6);
    expect(result.decision).toBe("review");
    expect(result.matchedSignals).toContain("email_fuzzy_strong");
  });

  // -------------------------------------------------------------------------
  // Case 10 — null/missing signals are silently skipped
  // -------------------------------------------------------------------------
  it("skips null signals without error", async () => {
    const result = await scorePostOrder(baseInput({ signals: {} }));

    expect(result.score).toBe(0);
    expect(result.decision).toBe("allow");
    expect(result.hashes).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Case 11 — per-record max: take the best-matching record
  // -------------------------------------------------------------------------
  it("picks the record with the highest per-record score", async () => {
    const probe = await scorePostOrder(
      baseInput({
        signals: {
          email: "best@example.com",
          phone: "+14155551234",
          addressLine1: "99 Oak Ave",
          addressZip: "10001",
          addressCountry: "US",
        },
      }),
    );
    const emailHash = probe.hashes["email_canonical"];
    const phoneHash = probe.hashes["phone"];

    // Record A: only phone match (score 10)
    // Record B: email + phone match (score 20) — should win
    mockFindMany.mockResolvedValue([
      {
        id: "rec_A",
        phoneHash,
        emailCanonicalHash: null,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
      {
        id: "rec_B",
        phoneHash,
        emailCanonicalHash: emailHash,
        addressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({
        signals: {
          email: "best@example.com",
          phone: "+14155551234",
          addressLine1: "99 Oak Ave",
          addressZip: "10001",
          addressCountry: "US",
        },
      }),
    );

    expect(result.score).toBe(20);
    expect(result.matchedSignals).toContain("email_canonical");
    expect(result.matchedSignals).toContain("phone");
  });

  // -------------------------------------------------------------------------
  // Case 12 — hashes record is populated for new RedemptionRecord storage
  // -------------------------------------------------------------------------
  it("returns computed hashes for all provided signals", async () => {
    const result = await scorePostOrder(
      baseInput({
        signals: {
          email: "store@example.com",
          phone: "+14155557890",
          addressLine1: "1 Market St",
          addressZip: "94105",
          addressCountry: "US",
          ip: "10.0.0.1",
          deviceFingerprint: "fp_abc",
        },
      }),
    );

    expect(result.hashes).toHaveProperty("email_canonical");
    expect(result.hashes).toHaveProperty("phone");
    expect(result.hashes).toHaveProperty("address_full");
    expect(result.hashes).toHaveProperty("address_house");
    expect(result.hashes).toHaveProperty("ip_v4_24");
    expect(result.hashes).toHaveProperty("device");

    // All hashes are 8-char lowercase hex
    for (const [, v] of Object.entries(result.hashes)) {
      expect(v).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  // -------------------------------------------------------------------------
  // Case 13 — Billing address matches stored shipping (cross-slot)
  // -------------------------------------------------------------------------
  it("matches incoming billing against a stored shipping address", async () => {
    const probe = await scorePostOrder(
      baseInput({
        signals: {
          billingAddressLine1: "123 Home Ln",
          billingAddressZip: "94000",
          billingAddressCountry: "US",
        },
      }),
    );
    const billingHash = probe.hashes["billing_address_full"];
    expect(billingHash).toBeDefined();

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: billingHash, // stored in shipping slot on prior order
        billingAddressFullHash: null,
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({
        signals: {
          billingAddressLine1: "123 Home Ln",
          billingAddressZip: "94000",
          billingAddressCountry: "US",
        },
      }),
    );

    expect(result.score).toBe(10);
    expect(result.decision).toBe("block");
    expect(result.matchedSignals).toContain("address_full");
  });

  // -------------------------------------------------------------------------
  // Case 14 — Shipping varies, stored billing matches → address_full match
  // This is the "PO box + real credit-card address" abuse pattern.
  // -------------------------------------------------------------------------
  it("matches incoming shipping against a stored billing address", async () => {
    const probe = await scorePostOrder(
      baseInput({
        signals: {
          addressLine1: "123 Home Ln",
          addressZip: "94000",
          addressCountry: "US",
        },
      }),
    );
    const shippingHash = probe.hashes["address_full"];
    expect(shippingHash).toBeDefined();

    mockFindMany.mockResolvedValue([
      {
        id: "rec_1",
        phoneHash: null,
        emailCanonicalHash: null,
        addressFullHash: "deadbeef", // different shipping on prior order
        billingAddressFullHash: shippingHash, // prior billing = our shipping
        ipHash24: null,
        emailMinhashSketch: null,
        addressMinhashSketch: null,
      },
    ]);

    const result = await scorePostOrder(
      baseInput({
        signals: {
          addressLine1: "123 Home Ln",
          addressZip: "94000",
          addressCountry: "US",
        },
      }),
    );

    expect(result.score).toBe(10);
    expect(result.decision).toBe("block");
    expect(result.matchedSignals).toContain("address_full");
  });
});
