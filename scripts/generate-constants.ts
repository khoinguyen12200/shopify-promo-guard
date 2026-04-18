/**
 * Regenerates shared-rust/src/scoring/constants.rs and app/lib/scoring/constants.server.ts
 * from the single JSON source docs/scoring-constants.json. Run with `tsx scripts/generate-constants.ts`.
 */
import fs from "node:fs";

const src = JSON.parse(fs.readFileSync("docs/scoring-constants.json", "utf8"));
const weights = src.weights as Record<string, number>;

// Rust
const rustLines = [
  "//! Auto-generated from docs/scoring-constants.json via scripts/generate-constants.ts.",
  "//! Do not edit by hand. Edit the JSON and rerun.",
  "//!",
  "//! See: docs/scoring-spec.md §3",
  "",
  `pub const SCORING_VERSION: u32 = ${src.version};`,
  "",
  `pub const THRESHOLD_MEDIUM: u32 = ${src.thresholds.medium};`,
  `pub const THRESHOLD_HIGH: u32 = ${src.thresholds.high};`,
  "",
];
for (const [k, v] of Object.entries(weights)) {
  rustLines.push(`pub const W_${k.toUpperCase()}: u32 = ${v};`);
}
fs.writeFileSync("shared-rust/src/scoring/constants.rs", rustLines.join("\n") + "\n");

// TS
const tsLines = [
  "/**",
  " * Auto-generated from docs/scoring-constants.json via scripts/generate-constants.ts.",
  " * Do not edit by hand. Edit the JSON and rerun.",
  " *",
  " * See: docs/scoring-spec.md §3",
  " */",
  `export const SCORING_VERSION = ${src.version};`,
  "",
  `export const THRESHOLD_MEDIUM = ${src.thresholds.medium};`,
  `export const THRESHOLD_HIGH = ${src.thresholds.high};`,
  "",
  "export const WEIGHTS = {",
];
for (const [k, v] of Object.entries(weights)) tsLines.push(`  ${k}: ${v},`);
tsLines.push("} as const;");
fs.writeFileSync("app/lib/scoring/constants.server.ts", tsLines.join("\n") + "\n");

console.log("Regenerated scoring constants.");
