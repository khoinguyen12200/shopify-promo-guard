/**
 * See: docs/normalization-spec.md §8 (card name + last4)
 *      docs/scoring-spec.md §4.9 (card_name_last4)
 *
 * Tag: `card_name_last4`. The key is `normalize(name) + ":" + last4` —
 * both components are individually non-PCI-regulated (name is just a name;
 * last 4 digits are explicitly non-sensitive per PCI-DSS §3.3 truncation
 * rules), and the combined form is what every receipt prints.
 *
 * Name normalization mirrors what we do for addresses/emails: lowercase,
 * strip diacritics, collapse internal whitespace, strip leading/trailing
 * punctuation. Last4 is kept verbatim as 4 decimal digits.
 */

const DIACRITICS_RE = /[\u0300-\u036f]/g;
const NON_NAME_CHARS_RE = /[^\p{L}\p{N}\s']/gu;

function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .replace(NON_NAME_CHARS_RE, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the normalized `name:last4` key. Returns null when either input is
 * missing, empty after normalization, or the last4 isn't 4 decimal digits.
 */
export function normalizeCardNameLast4(
  name: string | null | undefined,
  last4: string | null | undefined,
): string | null {
  if (!name || !last4) return null;

  const cleanLast4 = last4.trim().replace(/\D/g, "");
  if (cleanLast4.length !== 4) return null;

  const cleanName = normalizeName(name);
  if (!cleanName) return null;

  return `${cleanName}:${cleanLast4}`;
}
