/**
 * See: docs/platform-admin-spec.md §8 (impersonation — support mode)
 *
 * Implementation: signed cookie (HMAC-SHA256) that carries shopId +
 * adminUserId + expiresAt. No DB row required — the signature proves
 * authenticity and the expiresAt bounds the blast radius to 15 minutes.
 *
 * Read-only is enforced by:
 *   1. `requireReadOnly(request)` — call at the top of any action handler
 *      that mutates; throws 403 when impersonating.
 *   2. `<ImpersonationBanner/>` — rendered from `app.tsx` on every embedded
 *      page so the viewer always knows they're in support mode.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const IMPERSONATION_COOKIE = "__pg_impersonate";
const TTL_MS = 15 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.MAGIC_LINK_SECRET;
  if (!secret) throw new Error("MAGIC_LINK_SECRET env var is not set");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface ImpersonationSession {
  shopId: string;
  adminUserId: string;
  shopDomain: string;
  expiresAt: number;
}

/** Encode a token as `base64(payload).sig`. Payload is JSON. */
export function mintImpersonationToken(args: {
  shopId: string;
  adminUserId: string;
  shopDomain: string;
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  const session: ImpersonationSession = {
    shopId: args.shopId,
    adminUserId: args.adminUserId,
    shopDomain: args.shopDomain,
    expiresAt: now + TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function parseImpersonationToken(
  token: string,
  now: number = Date.now(),
): ImpersonationSession | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sign(payload), sig)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<ImpersonationSession>;
    if (
      typeof decoded.shopId !== "string" ||
      typeof decoded.adminUserId !== "string" ||
      typeof decoded.shopDomain !== "string" ||
      typeof decoded.expiresAt !== "number"
    ) {
      return null;
    }
    if (decoded.expiresAt <= now) return null;
    return decoded as ImpersonationSession;
  } catch {
    return null;
  }
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.split("=");
    if (k.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}

export function readImpersonationSession(
  request: Request,
): ImpersonationSession | null {
  const raw = parseCookie(request.headers.get("Cookie") ?? "", IMPERSONATION_COOKIE);
  if (!raw) return null;
  return parseImpersonationToken(raw);
}

export function isImpersonating(request: Request): boolean {
  return readImpersonationSession(request) !== null;
}

/** Set-Cookie header that installs the impersonation token. */
export function buildImpersonationCookie(token: string): string {
  const maxAge = Math.floor(TTL_MS / 1000);
  return `${IMPERSONATION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

/** Set-Cookie header that clears the impersonation token. */
export function clearImpersonationCookie(): string {
  return `${IMPERSONATION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`;
}

export class ReadOnlyViolation extends Error {
  constructor(message = "Action disabled in impersonation mode (read-only).") {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

/**
 * Call at the top of any /app action handler that mutates state. In a normal
 * merchant session this is a no-op; in an impersonation session this throws
 * a 403 Response so the mutation can't land.
 */
export function requireReadOnly(request: Request): void {
  if (isImpersonating(request)) {
    throw new Response("Read-only — impersonation in progress.", {
      status: 403,
    });
  }
}
