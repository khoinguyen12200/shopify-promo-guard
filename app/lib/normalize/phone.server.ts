/**
 * See: docs/normalization-spec.md §2
 *
 * Fixture: docs/test-fixtures/phone-vectors.json
 * Rust port: shared-rust/src/normalize/phone.rs
 *
 * Byte-for-byte port of the Rust `canonical_phone`. Parity is enforced by
 * loading the shared JSON fixture in both test suites.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Canonicalize a raw phone string into E.164 form.
 *
 * `defaultPrefix` must include the leading `+` (e.g. `"+84"`). When the input
 * doesn't already carry its own country prefix and `defaultPrefix` is null,
 * the function returns null.
 */
export function canonicalPhone(
  raw: string | null | undefined,
  defaultPrefix: string | null,
): string | null {
  // 1. null/empty → null
  if (raw == null || raw.length === 0) {
    return null;
  }

  // 2. Strip whitespace, ASCII dashes, parens, dots.
  let stripped = "";
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    if (ch === "-" || ch === "(" || ch === ")" || ch === ".") continue;
    stripped += ch;
  }

  if (stripped.length === 0) {
    return null;
  }

  // 3/4/5/6. Resolve the leading token into a `+`-prefixed digit string.
  let candidate: string;
  if (stripped.startsWith("+")) {
    candidate = "+" + keepOnlyDigits(stripped.slice(1));
  } else if (stripped.startsWith("00")) {
    candidate = "+" + keepOnlyDigits(stripped.slice(2));
  } else if (stripped.startsWith("0")) {
    if (defaultPrefix == null) return null;
    candidate = defaultPrefix + keepOnlyDigits(stripped.slice(1));
  } else {
    if (defaultPrefix == null) return null;
    candidate = defaultPrefix + keepOnlyDigits(stripped);
  }

  // 7. Validate against ^\+[1-9]\d{6,14}$.
  if (!E164_RE.test(candidate)) {
    return null;
  }

  // 8. Return.
  return candidate;
}

function keepOnlyDigits(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) out += s[i];
  }
  return out;
}
