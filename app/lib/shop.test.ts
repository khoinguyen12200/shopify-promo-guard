/**
 * See: docs/database-design.md § Encryption approach
 * Related: app/lib/shop.server.ts
 *
 * Integration tests — hit the real dev Postgres (localhost:5434) per CLAUDE.md.
 * Each test uses a unique shopDomain so we never depend on global cleanup.
 */

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import prisma from "../db.server.js";
import { loadKek, unwrapDek } from "./crypto.server.js";
import { ensureShop } from "./shop.server.js";

// Track the domains we create so the suite cleans up after itself, without
// affecting unrelated rows another developer might have seeded.
const createdDomains: string[] = [];

function uniqueDomain(tag: string): string {
  const suffix = randomBytes(6).toString("hex");
  const domain = `test-${tag}-${suffix}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

afterAll(async () => {
  if (createdDomains.length > 0) {
    await prisma.shop.deleteMany({
      where: { shopDomain: { in: createdDomains } },
    });
  }
  await prisma.$disconnect();
});

describe("ensureShop — first install", () => {
  it("generates a 64-char hex salt and a non-empty wrapped DEK", async () => {
    const shop = await ensureShop({
      shopDomain: uniqueDomain("first"),
      accessToken: "token-abc",
      scope: "write_products",
    });

    expect(shop.salt).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(shop.salt)).toBe(true);

    expect(shop.encryptionKey).not.toBe("");
    // The wrapped DEK must be unwrappable under the app KEK.
    const kek = loadKek();
    const dek = unwrapDek(shop.encryptionKey, kek);
    expect(dek.length).toBe(32);

    expect(shop.accessToken).toBe("token-abc");
    expect(shop.scope).toBe("write_products");
    expect(shop.uninstalledAt).toBeNull();
  });
});

describe("ensureShop — idempotency", () => {
  it("two calls with the same domain produce the same row (same id, salt, DEK)", async () => {
    const domain = uniqueDomain("idem");

    const first = await ensureShop({
      shopDomain: domain,
      accessToken: "token-1",
      scope: "write_products",
    });
    const second = await ensureShop({
      shopDomain: domain,
      accessToken: "token-1",
      scope: "write_products",
    });

    expect(second.id).toBe(first.id);
    expect(second.salt).toBe(first.salt);
    expect(second.encryptionKey).toBe(first.encryptionKey);
  });

  it("updates accessToken and scope on a second call without touching salt/DEK", async () => {
    const domain = uniqueDomain("reauth");

    const first = await ensureShop({
      shopDomain: domain,
      accessToken: "token-old",
      scope: "read_products",
    });
    const second = await ensureShop({
      shopDomain: domain,
      accessToken: "token-new",
      scope: "write_products,read_orders",
    });

    expect(second.id).toBe(first.id);
    expect(second.salt).toBe(first.salt);
    expect(second.encryptionKey).toBe(first.encryptionKey);
    expect(second.accessToken).toBe("token-new");
    expect(second.scope).toBe("write_products,read_orders");
  });
});

describe("ensureShop — reinstall after soft-delete", () => {
  it("clears uninstalledAt and refreshes token/scope, keeping salt + DEK", async () => {
    const domain = uniqueDomain("reinstall");

    const initial = await ensureShop({
      shopDomain: domain,
      accessToken: "token-initial",
      scope: "write_products",
    });

    // Simulate app/uninstalled soft-delete.
    await prisma.shop.update({
      where: { id: initial.id },
      data: { uninstalledAt: new Date() },
    });

    const reinstalled = await ensureShop({
      shopDomain: domain,
      accessToken: "token-reinstall",
      scope: "write_products,read_orders",
    });

    expect(reinstalled.id).toBe(initial.id);
    expect(reinstalled.salt).toBe(initial.salt);
    expect(reinstalled.encryptionKey).toBe(initial.encryptionKey);
    expect(reinstalled.accessToken).toBe("token-reinstall");
    expect(reinstalled.scope).toBe("write_products,read_orders");
    expect(reinstalled.uninstalledAt).toBeNull();
  });
});
