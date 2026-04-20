/**
 * See: docs/normalization-spec.md §7 (signal type tags — `ip_v4_24`, `ip_v6_48`)
 * Used by: scorePostOrder, handleColdStart, handleOrdersPaid, handleRotateSalt
 *
 * Given a raw client IP from Shopify, return the prefix key to feed into
 * `hash_for_lookup(tag, key, salt)`. IPv4 collapses to /24 (first three
 * octets); IPv6 collapses to /48 (first three hextets, fully expanded and
 * leading-zero-stripped).
 *
 * Tag domain separation means a v4-tagged hash and a v6-tagged hash of the
 * same column `ipHash24` never collide, so callers safely store whichever
 * applies in the same column.
 */
export interface IpPrefix {
  key: string;
  tag: "ip_v4_24" | "ip_v6_48";
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(raw: string): string | null {
  const m = raw.match(IPV4_RE);
  if (!m) return null;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

function parseIpv6(raw: string): string | null {
  // Strip RFC 4007 zone id (e.g. "fe80::1%eth0").
  const noZone = raw.split("%", 1)[0];
  if (!noZone.includes(":")) return null;

  const segments = noZone.split("::");
  if (segments.length > 2) return null;

  const leftRaw = segments[0] ? segments[0].split(":") : [];
  const rightRaw =
    segments.length === 2 && segments[1] ? segments[1].split(":") : [];

  // Without "::" we must have exactly 8 hextets. With "::" we compute a fill.
  let hextets: string[];
  if (segments.length === 1) {
    if (leftRaw.length !== 8) return null;
    hextets = leftRaw;
  } else {
    const fill = 8 - leftRaw.length - rightRaw.length;
    if (fill < 0) return null;
    hextets = [...leftRaw, ...Array(fill).fill("0"), ...rightRaw];
  }

  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
  }

  const first3 = hextets
    .slice(0, 3)
    .map((h) => h.toLowerCase().replace(/^0+(?=.)/, ""));
  return first3.join(":");
}

/**
 * Derive the tagged prefix key for an IP. Returns null when the input isn't a
 * recognizable IPv4 or IPv6 literal (including empty, whitespace, or embedded
 * IPv4-in-IPv6 forms we don't support).
 */
export function ipPrefixKey(raw: string | null | undefined): IpPrefix | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const v4 = parseIpv4(trimmed);
  if (v4) return { key: v4, tag: "ip_v4_24" };

  const v6 = parseIpv6(trimmed);
  if (v6) return { key: v6, tag: "ip_v6_48" };

  return null;
}
