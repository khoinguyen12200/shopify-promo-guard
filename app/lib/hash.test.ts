/**
 * See: docs/normalization-spec.md §5, §7
 * Fixture: docs/test-fixtures/hash-vectors.json
 */

import { describe, it, expect } from "vitest";
import { fnv1a32, hashToHex, hashForLookup } from "./hash.server";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("fnv1a32 canonical", () => {
  it("empty", () => expect(hashToHex(fnv1a32(new Uint8Array()))).toBe("811c9dc5"));
  it("a", () => expect(hashToHex(fnv1a32(utf8("a")))).toBe("e40c292c"));
  it("hello", () => expect(hashToHex(fnv1a32(utf8("hello")))).toBe("4f9f2cab"));
});

describe("hashForLookup", () => {
  it("same salt+tag+value → same hash", () => {
    const s = utf8("s");
    const v = utf8("v");
    expect(hashForLookup("x", v, s)).toBe(hashForLookup("x", v, s));
  });
  it("different tag → different hash", () => {
    const s = utf8("s");
    const v = utf8("v");
    expect(hashForLookup("x", v, s)).not.toBe(hashForLookup("y", v, s));
  });
});
