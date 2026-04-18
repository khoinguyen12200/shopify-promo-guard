/**
 * See: docs/normalization-spec.md §6 (MinHash bottom-K)
 * Fixture: docs/test-fixtures/minhash-vectors.json
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeSketch, jaccardEstimate, hasSufficientOverlap } from "./minhash.server";

interface SketchCase {
  label: string;
  trigrams: string[];
  expected_sketch: number[];
}

interface JaccardCase {
  label: string;
  sketch_a: number[];
  sketch_b: number[];
  expected: number;
}

interface Fixture {
  version: number;
  salt_utf8: string;
  sketches: SketchCase[];
  jaccard: JaccardCase[];
}

const fixturePath = resolve(
  __dirname,
  "../../docs/test-fixtures/minhash-vectors.json",
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const salt = new TextEncoder().encode(fixture.salt_utf8);

describe("computeSketch (fixture parity)", () => {
  for (const c of fixture.sketches) {
    it(c.label, () => {
      const sketch = computeSketch(c.trigrams, salt);
      expect(sketch).toEqual(c.expected_sketch);
    });
  }
});

describe("jaccardEstimate (fixture parity)", () => {
  for (const c of fixture.jaccard) {
    it(c.label, () => {
      const got = jaccardEstimate(c.sketch_a, c.sketch_b);
      expect(got).toBeCloseTo(c.expected, 6);
    });
  }
});

describe("hasSufficientOverlap", () => {
  it("identical sketches meet threshold 1.0", () => {
    const s = [466682748, 733189310, 846147091, 1741988834];
    expect(hasSufficientOverlap(s, s, 1.0)).toBe(true);
  });
  it("disjoint sketches do not meet threshold 0.25", () => {
    const a = [466682748, 733189310, 846147091, 1741988834];
    const b = [222153778, 810471649, 3647606906, 4159444007];
    expect(hasSufficientOverlap(a, b, 0.25)).toBe(false);
  });
  it("0.5 overlap meets threshold 0.5", () => {
    const a = [466682748, 733189310, 846147091, 1741988834];
    const b = [466682748, 1741988834, 1869618924, 2441791470];
    expect(hasSufficientOverlap(a, b, 0.5)).toBe(true);
    expect(hasSufficientOverlap(a, b, 0.75)).toBe(false);
  });
});
