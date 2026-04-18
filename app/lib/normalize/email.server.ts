/**
 * See: docs/normalization-spec.md §1, §4
 *
 * Fixture: docs/test-fixtures/email-vectors.json
 * Rust port: shared-rust/src/normalize/email.rs
 *
 * Byte-for-byte port of the Rust `canonical_email` + `email_trigrams`, modulo
 * the documented NFKC divergence: Node uses V8's `String.prototype.normalize`,
 * Rust treats NFKC as pass-through in v1. For ASCII email inputs (the entire
 * real-world space we expect) the two implementations agree bit-for-bit.
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// ASCII-only lowercase, leaving non-ASCII code points untouched. Mirrors the
// Rust `c.to_ascii_lowercase()` behaviour so both sides produce identical
// output on inputs like "KHOI+anything@OUTLOOK.COM".
function asciiLowercase(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x41 && code <= 0x5a) {
      out += String.fromCharCode(code + 0x20);
    } else {
      out += input.charAt(i);
    }
  }
  return out;
}

// Strip ALL whitespace (not just leading/trailing). We match Rust's
// `char::is_whitespace`, which for practical purposes means any Unicode
// whitespace. JS `\s` covers the same set for all email-relevant chars.
function stripWhitespace(input: string): string {
  return input.replace(/\s+/gu, "");
}

/**
 * Canonicalize a raw email string per docs/normalization-spec.md §1.
 * Returns null for structurally-invalid input (no `@`, empty local/domain).
 */
export function canonicalEmail(raw: string): string | null {
  // 1. NFKC normalize (Node side does the real thing; see module docs).
  const nfkc = raw.normalize("NFKC");

  // 3. Trim surrounding whitespace (done before lowercase so step 2 operates
  // on a slimmer string — order doesn't matter for correctness).
  const trimmed = nfkc.trim();

  // 2. ASCII-only lowercase.
  const lower = asciiLowercase(trimmed);

  // 4. Require '@'. 5. Split at the LAST '@'.
  const atIdx = lower.lastIndexOf("@");
  if (atIdx < 0) {
    return null;
  }

  // 6. Strip all whitespace from local and domain separately.
  let local = stripWhitespace(lower.slice(0, atIdx));
  const domain = stripWhitespace(lower.slice(atIdx + 1));

  // 7. Trim from the first '+' in local (inclusive) to end.
  const plusIdx = local.indexOf("+");
  if (plusIdx >= 0) {
    local = local.slice(0, plusIdx);
  }

  // 8. Gmail dot-stripping.
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
  }

  // 9. Empty local after stripping → invalid.
  if (local.length === 0) {
    return null;
  }

  // Guard: empty domain is also invalid (matches Rust side + fixture
  // `"khoi.nguyen@"` → null).
  if (domain.length === 0) {
    return null;
  }

  // 10. Reassemble.
  return `${local}@${domain}`;
}

/**
 * Return the sorted, deduplicated 3-byte windows over the UTF-8 bytes of the
 * email's local part. Each entry is a `Uint8Array` of length 3. See
 * docs/normalization-spec.md §4.
 */
export function emailTrigrams(canonical: string): Uint8Array[] {
  // Take the local part only.
  const atIdx = canonical.lastIndexOf("@");
  const local = atIdx >= 0 ? canonical.slice(0, atIdx) : canonical;

  const bytes = new TextEncoder().encode(local);
  if (bytes.length < 3) {
    return [];
  }

  // Collect all 3-byte windows.
  const raw: Uint8Array[] = [];
  for (let i = 0; i + 3 <= bytes.length; i++) {
    raw.push(bytes.slice(i, i + 3));
  }

  // Sort lexicographically by byte.
  raw.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
  });

  // Dedupe adjacent equal triples.
  const out: Uint8Array[] = [];
  for (const tri of raw) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last[0] === tri[0] &&
      last[1] === tri[1] &&
      last[2] === tri[2]
    ) {
      continue;
    }
    out.push(tri);
  }
  return out;
}
