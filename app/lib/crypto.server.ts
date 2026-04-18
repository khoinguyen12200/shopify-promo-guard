/**
 * See: docs/database-design.md § Encryption approach
 * Related: docs/normalization-spec.md §7 (salt handling)
 *
 * AES-256-GCM envelope crypto:
 *   - KEK (Key Encryption Key) = 32 bytes, stored in env (APP_KEK_HEX). Never in DB.
 *   - DEK (Data Encryption Key) = 32 bytes, generated per shop, wrapped by KEK,
 *     stored base64 in Shop.encryptionKey. Unwrapped in-memory to encrypt/decrypt
 *     per-record PII ciphertexts.
 *
 * Envelope byte layout (same for wrapped DEK and payload ciphertexts):
 *   version(1) | iv(12) | ciphertext(N) | tag(16)
 *
 * The module exports pure functions that take a KEK/DEK Buffer — it does NOT
 * secretly read env. Call `loadKek()` at the edge and pass the result in.
 * That keeps the module trivially unit-testable.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "./env.server.js";

// -- Errors -----------------------------------------------------------------

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoConfigError";
  }
}

export class CryptoVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoVersionError";
  }
}

export class CryptoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoAuthError";
  }
}

// -- Constants --------------------------------------------------------------

export const ENVELOPE_VERSION = 1;
const IV_BYTES = 12; // GCM-recommended nonce length
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
const DEK_BYTES = 32;

// -- KEK loading ------------------------------------------------------------

/**
 * Read the App KEK from env and return it as a 32-byte Buffer.
 * Throws CryptoConfigError if missing or malformed. env.server.ts already
 * validates the format, but we defend in depth here because this is the one
 * function callers pass into every other helper.
 */
export function loadKek(): Buffer {
  const hex = env.APP_KEK_HEX;
  if (!hex) {
    throw new CryptoConfigError("APP_KEK_HEX is not set");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CryptoConfigError(
      "APP_KEK_HEX must be 64 hex chars (32 bytes)",
    );
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `APP_KEK_HEX must decode to ${KEY_BYTES} bytes, got ${buf.length}`,
    );
  }
  return buf;
}

// -- DEK lifecycle ----------------------------------------------------------

/** Generate a fresh 32-byte DEK (plaintext, in-memory only). */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/** AES-256-GCM wrap a DEK under the given KEK. Returns base64 envelope. */
export function wrapDek(dek: Buffer, kek: Buffer): string {
  assertKey(kek, "kek");
  if (dek.length !== DEK_BYTES) {
    throw new CryptoConfigError(
      `DEK must be ${DEK_BYTES} bytes, got ${dek.length}`,
    );
  }
  return sealEnvelope(dek, kek);
}

/** AES-256-GCM unwrap a DEK using the given KEK. */
export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  assertKey(kek, "kek");
  const dek = openEnvelope(wrapped, kek);
  if (dek.length !== DEK_BYTES) {
    throw new CryptoAuthError(
      `Unwrapped DEK has wrong length: ${dek.length} (expected ${DEK_BYTES})`,
    );
  }
  return dek;
}

/**
 * KEK rotation: unwrap the DEK under `oldKek`, re-wrap it under `newKek`.
 * Returned envelope carries the same DEK plaintext — per-record ciphertexts
 * do NOT need to be re-encrypted.
 */
export function rotateKek(
  wrapped: string,
  oldKek: Buffer,
  newKek: Buffer,
): string {
  const dek = unwrapDek(wrapped, oldKek);
  try {
    return wrapDek(dek, newKek);
  } finally {
    // Drop plaintext DEK reference ASAP. GC can still collect it, but zeroing
    // makes the window a little tighter.
    dek.fill(0);
  }
}

// -- Payload encrypt/decrypt ------------------------------------------------

/** Encrypt a payload with the shop's DEK. Returns base64 envelope. */
export function encrypt(plaintext: Buffer | string, dek: Buffer): string {
  assertKey(dek, "dek");
  const pt = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(plaintext, "utf8");
  return sealEnvelope(pt, dek);
}

/** Decrypt a payload with the shop's DEK. Returns the raw plaintext Buffer. */
export function decrypt(ciphertext: string, dek: Buffer): Buffer {
  assertKey(dek, "dek");
  return openEnvelope(ciphertext, dek);
}

// -- Internal ---------------------------------------------------------------

function assertKey(key: Buffer, name: "kek" | "dek"): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `${name} must be a ${KEY_BYTES}-byte Buffer, got ${
        Buffer.isBuffer(key) ? key.length + " bytes" : typeof key
      }`,
    );
  }
}

function sealEnvelope(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.alloc(1 + IV_BYTES + ct.length + TAG_BYTES);
  out.writeUInt8(ENVELOPE_VERSION, 0);
  iv.copy(out, 1);
  ct.copy(out, 1 + IV_BYTES);
  tag.copy(out, 1 + IV_BYTES + ct.length);
  return out.toString("base64");
}

function openEnvelope(b64: string, key: Buffer): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    throw new CryptoAuthError("ciphertext is not valid base64");
  }
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new CryptoAuthError("ciphertext is shorter than the envelope header");
  }
  const version = buf.readUInt8(0);
  if (version !== ENVELOPE_VERSION) {
    throw new CryptoVersionError(
      `unsupported envelope version ${version} (expected ${ENVELOPE_VERSION})`,
    );
  }
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const ct = buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    // Node throws a generic Error on auth-tag mismatch; normalize it.
    throw new CryptoAuthError(
      `ciphertext auth failed: ${(err as Error).message}`,
    );
  }
}
