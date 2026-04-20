import { describe, expect, it } from "vitest";

import { normalizeCardNameLast4 } from "./card.server.js";

describe("normalizeCardNameLast4", () => {
  it("combines normalized name with last4", () => {
    expect(normalizeCardNameLast4("Khoi Nguyen", "4242")).toBe(
      "khoi nguyen:4242",
    );
  });

  it("strips diacritics", () => {
    expect(normalizeCardNameLast4("Khôi Nguyễn", "4242")).toBe(
      "khoi nguyen:4242",
    );
  });

  it("lowercases, collapses whitespace, drops punctuation", () => {
    expect(normalizeCardNameLast4("  Khoi   NGUYEN, MR.  ", "4242")).toBe(
      "khoi nguyen mr:4242",
    );
  });

  it("preserves apostrophes in names", () => {
    expect(normalizeCardNameLast4("O'Brien", "1111")).toBe("o'brien:1111");
  });

  it("strips masking from last4", () => {
    expect(normalizeCardNameLast4("Jane Doe", "**** 4242")).toBe(
      "jane doe:4242",
    );
  });

  it("rejects empty name", () => {
    expect(normalizeCardNameLast4("", "4242")).toBeNull();
    expect(normalizeCardNameLast4("   ", "4242")).toBeNull();
  });

  it("rejects missing last4", () => {
    expect(normalizeCardNameLast4("Jane Doe", "")).toBeNull();
    expect(normalizeCardNameLast4("Jane Doe", null)).toBeNull();
  });

  it("rejects last4 that isn't 4 digits", () => {
    expect(normalizeCardNameLast4("Jane Doe", "42")).toBeNull();
    expect(normalizeCardNameLast4("Jane Doe", "abcd")).toBeNull();
    expect(normalizeCardNameLast4("Jane Doe", "42424")).toBeNull();
  });
});
