import { describe, it, expect } from "vitest";
import { THRESHOLD_MEDIUM, THRESHOLD_HIGH, WEIGHTS, SCORING_VERSION } from "./constants.server";

describe("scoring constants", () => {
  it("version", () => expect(SCORING_VERSION).toBe(1));
  it("thresholds", () => {
    expect(THRESHOLD_MEDIUM).toBe(4);
    expect(THRESHOLD_HIGH).toBe(10);
  });
  it("weights", () => {
    expect(WEIGHTS.phone_exact).toBe(10);
    expect(WEIGHTS.email_canonical_exact).toBe(10);
    expect(WEIGHTS.email_minhash_strong).toBe(6);
    expect(WEIGHTS.email_minhash_weak).toBe(4);
    expect(WEIGHTS.address_full_exact).toBe(10);
    expect(WEIGHTS.address_house_exact).toBe(8);
    expect(WEIGHTS.address_minhash_strong).toBe(6);
    expect(WEIGHTS.address_minhash_weak).toBe(4);
    expect(WEIGHTS.customer_tag).toBe(10);
    expect(WEIGHTS.ip_v4_24).toBe(2);
    expect(WEIGHTS.ip_v6_48).toBe(2);
  });
});
