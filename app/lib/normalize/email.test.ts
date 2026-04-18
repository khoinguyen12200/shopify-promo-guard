/**
 * See: docs/normalization-spec.md §1, §4
 * Fixture: docs/test-fixtures/email-vectors.json
 *
 * Parity test: the Node `canonicalEmail` + `emailTrigrams` must agree with the
 * Rust implementation for every case in the shared JSON fixture.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalEmail, emailTrigrams } from "./email.server";

type CanonCase = {
  input: string;
  expected: string | null;
};

type TrigramCase = {
  canonical_local: string;
  expected: string[];
};

type Fixture = {
  version: number;
  canonical: CanonCase[];
  trigrams: TrigramCase[];
};

const fixturePath = resolve(
  __dirname,
  "../../../docs/test-fixtures/email-vectors.json",
);
const fx: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("canonicalEmail fixture", () => {
  it("fixture version is 1", () => {
    expect(fx.version).toBe(1);
  });
  for (const c of fx.canonical) {
    it(`input=${JSON.stringify(c.input)}`, () => {
      expect(canonicalEmail(c.input)).toBe(c.expected);
    });
  }
});

describe("emailTrigrams fixture", () => {
  const td = new TextDecoder();
  for (const c of fx.trigrams) {
    it(`local=${JSON.stringify(c.canonical_local)}`, () => {
      // The trigram function operates on a full canonical email; append a
      // dummy domain so the "@"-split path is exercised just like on the
      // Rust side.
      const got = emailTrigrams(`${c.canonical_local}@x.com`).map((t) =>
        td.decode(t),
      );
      // Sort both sides — emailTrigrams returns sorted, expected is
      // declared in generation order; compare as sets for clarity.
      const gotSet = new Set(got);
      const wantSet = new Set(c.expected);
      expect(gotSet).toEqual(wantSet);
    });
  }
});
