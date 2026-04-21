/**
 * Mirrors `app/lib/normalize/{phone,email,address}.server.ts`. Pure functions
 * only — no Node `Buffer`, no fs, no globals. Validator runs in Javy/QuickJS
 * where only TextEncoder/Uint8Array are reliably available.
 *
 * MinHash trigram computation is INTENTIONALLY OMITTED here — see
 * docs/function-queries-spec.md §9 "MinHash sketch computation at checkout is
 * explicitly skipped in v1." Fuzzy matching is post-order only.
 */

// -- Phone ------------------------------------------------------------------

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function canonicalPhone(
  raw: string | null | undefined,
  defaultPrefix: string | null,
): string | null {
  if (raw == null || raw.length === 0) return null;

  let stripped = "";
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    if (ch === "-" || ch === "(" || ch === ")" || ch === ".") continue;
    stripped += ch;
  }
  if (stripped.length === 0) return null;

  let candidate: string;
  if (stripped.startsWith("+")) {
    candidate = "+" + onlyDigits(stripped.slice(1));
  } else if (stripped.startsWith("00")) {
    candidate = "+" + onlyDigits(stripped.slice(2));
  } else if (stripped.startsWith("0")) {
    if (defaultPrefix == null) return null;
    candidate = defaultPrefix + onlyDigits(stripped.slice(1));
  } else {
    if (defaultPrefix == null) return null;
    candidate = defaultPrefix + onlyDigits(stripped);
  }

  if (!E164_RE.test(candidate)) return null;
  return candidate;
}

function onlyDigits(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) out += s[i];
  }
  return out;
}

// -- Email ------------------------------------------------------------------

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

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

function stripWhitespace(input: string): string {
  return input.replace(/\s+/gu, "");
}

export function canonicalEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const nfkc = raw.normalize("NFKC");
  const trimmed = nfkc.trim();
  const lower = asciiLowercase(trimmed);

  const atIdx = lower.lastIndexOf("@");
  if (atIdx < 0) return null;

  let local = stripWhitespace(lower.slice(0, atIdx));
  const domain = stripWhitespace(lower.slice(atIdx + 1));

  const plusIdx = local.indexOf("+");
  if (plusIdx >= 0) local = local.slice(0, plusIdx);

  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\./g, "");

  if (local.length === 0) return null;
  if (domain.length === 0) return null;

  return `${local}@${domain}`;
}

// -- Address ----------------------------------------------------------------

const SUFFIX_MAP: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  place: "pl",
  court: "ct",
  terrace: "ter",
  apartment: "apt",
  suite: "ste",
  number: "no",
};

export function normalizeString(s: string | null | undefined): string {
  if (!s) return "";

  const nfkd = s.normalize("NFKD");
  let stripped = "";
  for (const ch of nfkd) {
    if (ch === "Đ" || ch === "đ") {
      stripped += "d";
      continue;
    }
    if (/\p{Mn}/u.test(ch)) continue;
    stripped += ch;
  }

  let out = "";
  let prevSpace = true;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    let ch = stripped[i];
    if (code >= 0x41 && code <= 0x5a) {
      ch = String.fromCharCode(code + 0x20);
    }
    const keep = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (keep) {
      out += ch;
      prevSpace = false;
    } else if (!prevSpace) {
      out += " ";
      prevSpace = true;
    }
  }
  if (out.endsWith(" ")) out = out.slice(0, -1);

  return applySuffixMap(out);
}

function applySuffixMap(s: string): string {
  if (!s) return "";
  return s
    .split(" ")
    .map((tok) => SUFFIX_MAP[tok] ?? tok)
    .join(" ");
}

function stripLeadingHouseNumber(s: string): string {
  if (!s) return "";
  const tokens = s.split(" ");
  if (tokens[0] && /^\d+[a-z]?$/.test(tokens[0])) {
    return tokens.slice(1).join(" ");
  }
  return s;
}

export interface AddressInput {
  line1: string | null;
  line2: string | null;
  zip: string | null;
  countryCode: string | null;
}

export function fullKey(addr: AddressInput): string {
  const n1 = normalizeString(addr.line1);
  const n2 = normalizeString(addr.line2);
  const zip = normalizeString(addr.zip);
  const cc = (addr.countryCode ?? "").toUpperCase();
  return `${n1}|${n2}|${zip}|${cc}`;
}

export function houseKey(addr: AddressInput): string {
  const n1 = normalizeString(addr.line1);
  const n1NoNum = stripLeadingHouseNumber(n1);
  const zip = normalizeString(addr.zip);
  const cc = (addr.countryCode ?? "").toUpperCase();
  return `${n1NoNum}|${zip}|${cc}`;
}
