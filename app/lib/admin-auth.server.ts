/**
 * See: docs/platform-admin-spec.md §17 (magic-link auth)
 * Related: docs/platform-admin-spec.md §2 (access control)
 */

import { createHmac, randomBytes } from "crypto";
import { redirect } from "react-router";
import prisma from "../db.server.js";

const SESSION_COOKIE = "__admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getMagicLinkSecret(): string {
  const secret = process.env.MAGIC_LINK_SECRET;
  if (!secret) throw new Error("MAGIC_LINK_SECRET env var is not set");
  return secret;
}

function getAllowedEmails(): string[] {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function getAppUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Generate 32 random bytes as hex. */
function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** HMAC-SHA256(secret, token) → hex. Stored instead of raw token. */
function hmacToken(token: string): string {
  return createHmac("sha256", getMagicLinkSecret()).update(token).digest("hex");
}

/**
 * Request a magic link for `email`. Returns the full magic-link URL.
 * In dev/test environments, also logs the token to stderr for easy testing.
 *
 * Throws if the email is not in the allowlist.
 */
export async function requestMagicLink(
  email: string,
  ipAddress?: string,
): Promise<string> {
  const normalised = email.trim().toLowerCase();
  const allowed = getAllowedEmails();

  if (!allowed.includes(normalised)) {
    throw new Error("Email not in admin allowlist");
  }

  const token = generateToken();
  const tokenHash = hmacToken(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  await prisma.magicLink.create({
    data: {
      email: normalised,
      tokenHash,
      expiresAt,
      ipAddress: ipAddress ?? null,
    },
  });

  const url = `${getAppUrl()}/admin/login?token=${token}`;

  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.error(`[admin-auth] magic-link token for ${normalised}: ${token}`);
    console.error(`[admin-auth] magic-link URL: ${url}`);
  }

  return url;
}

/**
 * Verify a magic-link token. Marks the link as used, upserts the AdminUser,
 * creates an AdminSession, and returns a session cookie value (the raw token —
 * only the hash is stored in DB).
 *
 * Throws if the token is invalid, expired, or already used.
 */
export async function verifyMagicLink(
  token: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<string> {
  const tokenHash = hmacToken(token);
  const now = new Date();

  const link = await prisma.magicLink.findUnique({ where: { tokenHash } });

  if (!link) throw new Error("Invalid magic link");
  if (link.usedAt) throw new Error("Magic link already used");
  if (link.expiresAt < now) throw new Error("Magic link expired");

  // Mark as used
  await prisma.magicLink.update({
    where: { id: link.id },
    data: { usedAt: now },
  });

  // Upsert admin user
  const adminUser = await prisma.adminUser.upsert({
    where: { email: link.email },
    update: { lastLoginAt: now },
    create: { email: link.email, lastLoginAt: now },
  });

  // Create session
  const sessionToken = generateToken();
  const sessionTokenHash = hmacToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.adminSession.create({
    data: {
      adminUserId: adminUser.id,
      tokenHash: sessionTokenHash,
      expiresAt,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    },
  });

  return sessionToken;
}

/**
 * Read the session cookie from a request, validate it, and return the AdminUser.
 * Throws a redirect to /admin/login if the session is missing or invalid.
 */
export async function requireAdminSession(request: Request) {
  const cookie = request.headers.get("Cookie") ?? "";
  const sessionToken = parseCookie(cookie, SESSION_COOKIE);

  if (!sessionToken) {
    throw redirect("/admin/login");
  }

  const tokenHash = hmacToken(sessionToken);
  const now = new Date();

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash },
    include: { adminUser: true },
  });

  if (!session || session.revokedAt || session.expiresAt < now) {
    throw redirect("/admin/login");
  }

  return session.adminUser;
}

/** Build a Set-Cookie header value for the admin session. */
export function buildSessionCookie(token: string): string {
  const maxAge = SESSION_TTL_MS / 1000;
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/admin`;
}

/** Build a Set-Cookie header that clears the admin session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/admin`;
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.split("=");
    if (k.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}
