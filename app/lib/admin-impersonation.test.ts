/**
 * See: docs/platform-admin-spec.md §8 (impersonation — support mode)
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  IMPERSONATION_COOKIE,
  ReadOnlyViolation,
  buildImpersonationCookie,
  clearImpersonationCookie,
  isImpersonating,
  mintImpersonationToken,
  parseImpersonationToken,
  readImpersonationSession,
  requireReadOnly,
} from "./admin-impersonation.server.js";

beforeAll(() => {
  process.env.MAGIC_LINK_SECRET =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

const now = 1_700_000_000_000;

describe("mint/parse roundtrip", () => {
  it("round-trips a valid session", () => {
    const token = mintImpersonationToken({
      shopId: "shop-1",
      adminUserId: "admin-1",
      shopDomain: "foo.myshopify.com",
      now,
    });
    const parsed = parseImpersonationToken(token, now);
    expect(parsed).toEqual({
      shopId: "shop-1",
      adminUserId: "admin-1",
      shopDomain: "foo.myshopify.com",
      expiresAt: now + 15 * 60 * 1000,
    });
  });

  it("rejects a tampered payload (bad signature)", () => {
    const token = mintImpersonationToken({
      shopId: "shop-1",
      adminUserId: "admin-1",
      shopDomain: "foo.myshopify.com",
      now,
    });
    const [payload, sig] = token.split(".");
    const tampered = `${payload.slice(0, -2)}AA.${sig}`;
    expect(parseImpersonationToken(tampered, now)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = mintImpersonationToken({
      shopId: "shop-1",
      adminUserId: "admin-1",
      shopDomain: "foo.myshopify.com",
      now,
    });
    expect(
      parseImpersonationToken(token, now + 16 * 60 * 1000),
    ).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseImpersonationToken("garbage", now)).toBeNull();
    expect(parseImpersonationToken("no-dot-here", now)).toBeNull();
  });
});

describe("cookie roundtrip", () => {
  it("reads the session from a Request", () => {
    const token = mintImpersonationToken({
      shopId: "shop-1",
      adminUserId: "admin-1",
      shopDomain: "foo.myshopify.com",
    });
    const req = new Request("https://example.com/app", {
      headers: { Cookie: `${IMPERSONATION_COOKIE}=${token}` },
    });
    const session = readImpersonationSession(req);
    expect(session?.shopId).toBe("shop-1");
    expect(isImpersonating(req)).toBe(true);
  });

  it("returns null when no cookie is set", () => {
    const req = new Request("https://example.com/app");
    expect(readImpersonationSession(req)).toBeNull();
    expect(isImpersonating(req)).toBe(false);
  });

  it("builds Set-Cookie headers", () => {
    expect(buildImpersonationCookie("abc")).toContain(
      `${IMPERSONATION_COOKIE}=abc`,
    );
    expect(clearImpersonationCookie()).toContain("Max-Age=0");
  });
});

describe("requireReadOnly", () => {
  it("throws a 403 Response when impersonating", () => {
    const token = mintImpersonationToken({
      shopId: "shop-1",
      adminUserId: "admin-1",
      shopDomain: "foo.myshopify.com",
    });
    const req = new Request("https://example.com/app", {
      headers: { Cookie: `${IMPERSONATION_COOKIE}=${token}` },
    });
    let thrown: unknown;
    try {
      requireReadOnly(req);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });

  it("is a no-op for a normal session", () => {
    const req = new Request("https://example.com/app");
    expect(() => requireReadOnly(req)).not.toThrow();
  });

  it("ReadOnlyViolation is an error type for manual throws", () => {
    const err = new ReadOnlyViolation();
    expect(err.name).toBe("ReadOnlyViolation");
  });
});
