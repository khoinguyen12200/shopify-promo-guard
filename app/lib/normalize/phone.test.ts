/**
 * See: docs/normalization-spec.md §2
 * Fixture: docs/test-fixtures/phone-vectors.json
 *
 * Parity test: the Node `canonicalPhone` must agree with the Rust
 * implementation for every case in the shared JSON fixture.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPhone } from "./phone.server";

type Case = {
  input: string;
  default: string | null;
  expected: string | null;
};

type Fixture = {
  version: number;
  cases: Case[];
};

const fixturePath = resolve(
  __dirname,
  "../../../docs/test-fixtures/phone-vectors.json",
);
const fx: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("canonicalPhone fixture", () => {
  for (const c of fx.cases) {
    it(`input=${JSON.stringify(c.input)} default=${JSON.stringify(c.default)}`, () => {
      expect(canonicalPhone(c.input, c.default)).toBe(c.expected);
    });
  }
});
