/**
 * Fixture-parity tests for address normalization.
 * See: docs/normalization-spec.md §3, §4
 * Fixture: docs/test-fixtures/address-vectors.json
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizeString,
  stripLeadingHouseNumber,
  fullKey,
  houseKey,
  addressTrigrams,
} from "./address.server";

interface AddrCase {
  line1: string;
  line2: string;
  zip: string;
  country_code: string;
}

interface Fixture {
  version: number;
  normalize_string: { input: string; expected: string }[];
  strip_leading_house_number: { input: string; expected: string }[];
  keys: { addr: AddrCase; full: string; house: string }[];
  trigrams: { n1: string; zip: string; cc: string; expected: string[] }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(__dirname, "../../../docs/test-fixtures/address-vectors.json"),
    "utf8"
  )
);

describe("address normalizer — fixture parity (version 1)", () => {
  it("fixture version = 1", () => {
    expect(fixture.version).toBe(1);
  });

  describe("normalizeString", () => {
    for (const { input, expected } of fixture.normalize_string) {
      it(`normalizeString(${JSON.stringify(input)}) = ${JSON.stringify(expected)}`, () => {
        expect(normalizeString(input)).toBe(expected);
      });
    }
  });

  describe("stripLeadingHouseNumber", () => {
    for (const { input, expected } of fixture.strip_leading_house_number) {
      it(`stripLeadingHouseNumber(${JSON.stringify(input)}) = ${JSON.stringify(expected)}`, () => {
        expect(stripLeadingHouseNumber(input)).toBe(expected);
      });
    }
  });

  describe("fullKey / houseKey", () => {
    for (const { addr, full, house } of fixture.keys) {
      it(`keys for ${JSON.stringify(addr.line1)}`, () => {
        const a = {
          line1: addr.line1,
          line2: addr.line2,
          zip: addr.zip,
          countryCode: addr.country_code,
        };
        expect(fullKey(a)).toBe(full);
        expect(houseKey(a)).toBe(house);
      });
    }
  });

  describe("addressTrigrams", () => {
    for (const { n1, zip, cc, expected } of fixture.trigrams) {
      it(`trigrams for n1=${JSON.stringify(n1)}`, () => {
        const got = addressTrigrams(n1, zip, cc);
        expect(got.slice().sort()).toEqual(expected.slice().sort());
      });
    }
  });
});
