/**
 * See: docs/normalization-spec.md §5, §7
 * Fixture: docs/test-fixtures/hash-vectors.json
 *
 * Run via `npx tsx scripts/verify-fixtures.ts`. Exits non-zero if the Node
 * hash port disagrees with any vector. The Rust side is verified by
 * `cargo test --test fixture_vectors`.
 */

import fs from "node:fs";
import {
  fnv1a32,
  fnv1aSalted,
  hashForLookup,
  hashToHex,
} from "../app/lib/hash.server";

type Case32 = { input_utf8: string; hex: string };
type CaseSalted = { input_utf8: string; hex: string };
type CaseLookup = { tag: string; value_utf8: string; hex: string };
type Fixture = {
  version: number;
  salt_utf8: string;
  fnv1a_32: Case32[];
  fnv1a_salted: CaseSalted[];
  hash_for_lookup: CaseLookup[];
};

const fx: Fixture = JSON.parse(
  fs.readFileSync("docs/test-fixtures/hash-vectors.json", "utf8"),
);
const utf8 = (s: string) => new TextEncoder().encode(s);
const salt = utf8(fx.salt_utf8);
let fail = 0;

for (const c of fx.fnv1a_32) {
  const g = hashToHex(fnv1a32(utf8(c.input_utf8)));
  if (g !== c.hex) {
    console.error(`fnv1a_32 ${JSON.stringify(c.input_utf8)}: ${g} != ${c.hex}`);
    fail++;
  }
}
for (const c of fx.fnv1a_salted) {
  const g = hashToHex(fnv1aSalted(salt, utf8(c.input_utf8)));
  if (g !== c.hex) {
    console.error(`salted ${JSON.stringify(c.input_utf8)}: ${g} != ${c.hex}`);
    fail++;
  }
}
for (const c of fx.hash_for_lookup) {
  const g = hashToHex(hashForLookup(c.tag, utf8(c.value_utf8), salt));
  if (g !== c.hex) {
    console.error(
      `lookup ${c.tag}:${JSON.stringify(c.value_utf8)}: ${g} != ${c.hex}`,
    );
    fail++;
  }
}

if (fail) {
  console.error(`${fail} mismatches`);
  process.exit(1);
}
console.log(
  `✅ Node parity: ${fx.fnv1a_32.length + fx.fnv1a_salted.length + fx.hash_for_lookup.length} vectors`,
);
