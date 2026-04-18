/**
 * See: docs/database-design.md § Encryption approach
 * Related: app/lib/crypto.server.ts
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CryptoAuthError,
  CryptoConfigError,
  CryptoVersionError,
  decrypt,
  encrypt,
  generateDek,
  loadKek,
  rotateKek,
  unwrapDek,
  wrapDek,
} from "./crypto.server.js";

function kek(): Buffer {
  return randomBytes(32);
}

describe("crypto.server — encrypt/decrypt", () => {
  it("round-trips a 32-byte buffer", () => {
    const dek = generateDek();
    const plaintext = randomBytes(32);
    const ct = encrypt(plaintext, dek);
    const pt = decrypt(ct, dek);
    expect(pt.equals(plaintext)).toBe(true);
  });

  it("round-trips a UTF-8 string (including multi-byte chars)", () => {
    const dek = generateDek();
    const plaintext = "khoi.nguyen@gmail.com — xin chào 🇻🇳";
    const ct = encrypt(plaintext, dek);
    const pt = decrypt(ct, dek);
    expect(pt.toString("utf8")).toBe(plaintext);
  });

  it("produces a fresh IV per call (two encrypts of the same plaintext differ)", () => {
    const dek = generateDek();
    const a = encrypt("same-input", dek);
    const b = encrypt("same-input", dek);
    expect(a).not.toBe(b);
  });

  it("throws CryptoAuthError when ciphertext is tampered", () => {
    const dek = generateDek();
    const ct = encrypt("secret payload", dek);
    const buf = Buffer.from(ct, "base64");
    // Flip a bit deep in the body so we don't hit the version check.
    buf[buf.length - 5] ^= 0x01;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, dek)).toThrow(CryptoAuthError);
  });

  it("throws CryptoVersionError when the version byte is wrong", () => {
    const dek = generateDek();
    const ct = encrypt("hello", dek);
    const buf = Buffer.from(ct, "base64");
    buf.writeUInt8(99, 0);
    expect(() => decrypt(buf.toString("base64"), dek)).toThrow(
      CryptoVersionError,
    );
  });

  it("rejects a wrong DEK (different key) with CryptoAuthError", () => {
    const dek1 = generateDek();
    const dek2 = generateDek();
    const ct = encrypt("payload", dek1);
    expect(() => decrypt(ct, dek2)).toThrow(CryptoAuthError);
  });
});

describe("crypto.server — DEK wrap/unwrap", () => {
  it("round-trips the DEK byte-for-byte", () => {
    const k = kek();
    const dek = generateDek();
    const wrapped = wrapDek(dek, k);
    const unwrapped = unwrapDek(wrapped, k);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("refuses to unwrap under a different KEK", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, kek());
    expect(() => unwrapDek(wrapped, kek())).toThrow(CryptoAuthError);
  });

  it("rotates KEK: old-wrapped → new-wrapped produces the same DEK", () => {
    const oldKek = kek();
    const newKek = kek();
    const dek = generateDek();

    const wrappedOld = wrapDek(dek, oldKek);
    const wrappedNew = rotateKek(wrappedOld, oldKek, newKek);

    // Unwrap via new KEK should produce the original DEK.
    expect(unwrapDek(wrappedNew, newKek).equals(dek)).toBe(true);
    // And old KEK should no longer work on the rotated envelope.
    expect(() => unwrapDek(wrappedNew, oldKek)).toThrow(CryptoAuthError);
  });
});

describe("crypto.server — key validation", () => {
  it("throws CryptoConfigError on wrong-length KEK", () => {
    const badKek = Buffer.alloc(16); // 128-bit, not 256
    const dek = generateDek();
    expect(() => wrapDek(dek, badKek)).toThrow(CryptoConfigError);
  });

  it("throws CryptoConfigError on wrong-length DEK", () => {
    const dek = randomBytes(16);
    expect(() => wrapDek(dek, kek())).toThrow(CryptoConfigError);
  });

  it("throws CryptoConfigError when encrypt is given a non-32-byte DEK", () => {
    const dek = randomBytes(16);
    expect(() => encrypt("hi", dek)).toThrow(CryptoConfigError);
  });

  it("loadKek() returns a 32-byte Buffer under test env", () => {
    // test-setup.ts asserts APP_KEK_HEX is present.
    const k = loadKek();
    expect(k).toBeInstanceOf(Buffer);
    expect(k.length).toBe(32);
  });
});
