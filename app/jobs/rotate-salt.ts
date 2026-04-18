/**
 * See: docs/admin-ui-spec.md §9 (Settings — Rotate salt),
 *      docs/normalization-spec.md §7 (salt handling),
 *      docs/function-queries-spec.md §9 (Plan C shop-wide shard)
 *
 * Handler for the `rotate_salt` job enqueued from the Settings page.
 *
 * 1. Generate a new 32-byte hex salt.
 * 2. Bump `Shop.saltVersion` and write the new salt back.
 * 3. Re-derive every `RedemptionRecord` hash column by decrypting the stored
 *    ciphertexts, canonicalising, and hashing with the new salt.
 * 4. Rebuild the shop-wide shard metafield from the freshly re-hashed rows.
 *
 * Decryption happens only in-memory; the DEK is zeroed in `finally`.
 */

import type { RedemptionRecord } from "@prisma/client";
import { randomBytes } from "node:crypto";

import prisma from "../db.server.js";
import { decrypt, loadKek, unwrapDek } from "../lib/crypto.server.js";
import { hashForLookup, hashToHex } from "../lib/hash.server.js";
import type { JobHandler } from "../lib/jobs.server.js";
import { computeSketch } from "../lib/minhash.server.js";
import {
  addressTrigrams,
  fullKey,
} from "../lib/normalize/address.server.js";
import {
  canonicalEmail,
  emailTrigrams,
} from "../lib/normalize/email.server.js";
import { canonicalPhone } from "../lib/normalize/phone.server.js";
import { resolveShopGid } from "../lib/shop.server.js";
import {
  mergeEntry,
  newShard,
  rebuildShard,
  type Shard,
  type ShardEntry,
} from "../lib/shards.server.js";
import { unauthenticated } from "../shopify.server.js";

export interface RotateSaltPayload {
  /** Set by the Settings form; used for audit / reason. */
  requestedAt?: string;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hashOrEmpty(
  tag: string,
  value: string | null | undefined,
  salt: Uint8Array,
): string {
  if (!value) return "";
  return hashToHex(hashForLookup(tag, new TextEncoder().encode(value), salt));
}

function tryDecryptUtf8(ciphertext: string | null, dek: Buffer): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext, dek).toString("utf8");
  } catch {
    return null;
  }
}

interface RehashResult {
  phoneHash: string | null;
  emailCanonicalHash: string | null;
  addressFullHash: string | null;
  ipHash24: string | null;
  emailMinhashSketch: string | null;
  addressMinhashSketch: string | null;
  entry: ShardEntry;
}

function rehashOne(
  record: RedemptionRecord,
  dek: Buffer,
  salt: Uint8Array,
): RehashResult {
  const emailPlain = tryDecryptUtf8(record.emailCiphertext, dek);
  const phonePlain = tryDecryptUtf8(record.phoneCiphertext, dek);
  const addrPlain = tryDecryptUtf8(record.addressCiphertext, dek);
  const ipPlain = tryDecryptUtf8(record.ipCiphertext, dek);

  const canonEmail = emailPlain ? canonicalEmail(emailPlain) : null;
  const canonPhone = phonePlain ? canonicalPhone(phonePlain, null) : null;

  let addressLine1 = "";
  let addressLine2 = "";
  let addressZip = "";
  let addressCountry = "";
  if (addrPlain) {
    try {
      const a = JSON.parse(addrPlain);
      addressLine1 = a?.address1 ?? "";
      addressLine2 = a?.address2 ?? "";
      addressZip = a?.zip ?? "";
      addressCountry = a?.country_code ?? "";
    } catch {
      // ignore — leaves address empty
    }
  }
  const addressFullStr = addrPlain
    ? fullKey({
        line1: addressLine1,
        line2: addressLine2,
        zip: addressZip,
        countryCode: addressCountry,
      })
    : "";

  const ip24 = ipPlain ? ipV4Slash24(ipPlain) : null;

  const phoneHash = canonPhone ? hashOrEmpty("phone", canonPhone, salt) : "";
  const emailCanonicalHash = canonEmail
    ? hashOrEmpty("email_canonical", canonEmail, salt)
    : "";
  const addressFullHash = addrPlain
    ? hashOrEmpty("address_full", addressFullStr, salt)
    : "";
  const ipHash24 = ip24 ? hashOrEmpty("ip_v4_24", ip24, salt) : "";

  const emailSketchArr = canonEmail
    ? computeSketch(
        emailTrigrams(canonEmail).map((t) =>
          new TextDecoder().decode(t),
        ),
        salt,
      )
    : undefined;
  const addrSketchArr =
    addrPlain && addressFullStr
      ? computeSketch(
          addressTrigrams(
            addressFullStr.split("|")[0] ?? "",
            addressFullStr.split("|")[2] ?? "",
            addressFullStr.split("|")[3] ?? "",
          ),
          salt,
        )
      : undefined;

  const entry: ShardEntry = {
    ts: Math.floor(record.createdAt.getTime() / 1000),
    phone: phoneHash,
    email: emailCanonicalHash,
    addr_full: addressFullHash,
    addr_house: "",
    ip24: ipHash24,
    device: "",
    email_sketch: padSketch(emailSketchArr),
    addr_sketch: padSketch(addrSketchArr),
  };

  return {
    phoneHash: phoneHash || null,
    emailCanonicalHash: emailCanonicalHash || null,
    addressFullHash: addressFullHash || null,
    ipHash24: ipHash24 || null,
    emailMinhashSketch: emailSketchArr ? JSON.stringify(emailSketchArr) : null,
    addressMinhashSketch: addrSketchArr ? JSON.stringify(addrSketchArr) : null,
    entry,
  };
}

function ipV4Slash24(ip: string): string {
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}`;
  return ip;
}

function padSketch(
  s: number[] | undefined,
): [number, number, number, number] {
  const a = s ?? [];
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
}

export const handleRotateSalt: JobHandler<unknown> = async (payload, ctx) => {
  void payload;
  const shop = await prisma.shop.findUnique({ where: { id: ctx.shopId } });
  if (!shop) return;

  const newSaltHex = randomBytes(32).toString("hex");
  const newSalt = hexBytes(newSaltHex);

  const kek = loadKek();
  const dek = unwrapDek(shop.encryptionKey, kek);

  try {
    // Re-derive every RedemptionRecord's hashes + sketches under the new salt.
    const records = await prisma.redemptionRecord.findMany({
      where: { shopId: shop.id },
    });

    for (const r of records) {
      const res = rehashOne(r, dek, newSalt);
      await prisma.redemptionRecord.update({
        where: { id: r.id },
        data: {
          phoneHash: res.phoneHash,
          emailCanonicalHash: res.emailCanonicalHash,
          addressFullHash: res.addressFullHash,
          ipHash24: res.ipHash24,
          emailMinhashSketch: res.emailMinhashSketch,
          addressMinhashSketch: res.addressMinhashSketch,
        },
      });
    }

    // Persist the new salt + bump version atomically after re-hashing lands.
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        salt: newSaltHex,
        saltVersion: { increment: 1 },
      },
    });

    // Rebuild the shop-wide shard metafield from the now-refreshed rows.
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    const shopGid = await resolveShopGid(shop, admin);
    const creds = {
      shopDomain: shop.shopDomain,
      shopGid,
    };

    const refreshed = await prisma.redemptionRecord.findMany({
      where: { shopId: shop.id },
    });

    let shard: Shard = newShard(newSaltHex, null);
    for (const r of refreshed) {
      // Use the freshly-computed hashes from the DB row.
      shard = mergeEntry(shard, {
        ts: Math.floor(r.createdAt.getTime() / 1000),
        phone: r.phoneHash ?? "",
        email: r.emailCanonicalHash ?? "",
        addr_full: r.addressFullHash ?? "",
        addr_house: "",
        ip24: r.ipHash24 ?? "",
        device: "",
        email_sketch: parseSketchJson(r.emailMinhashSketch),
        addr_sketch: parseSketchJson(r.addressMinhashSketch),
      });
    }
    await rebuildShard(admin.graphql, creds, shard);
  } finally {
    dek.fill(0);
  }
};

function parseSketchJson(
  raw: string | null,
): [number, number, number, number] {
  if (!raw) return [0, 0, 0, 0];
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((n) => typeof n === "number")
    ) {
      return parsed as [number, number, number, number];
    }
  } catch {
    // fall through
  }
  return [0, 0, 0, 0];
}
