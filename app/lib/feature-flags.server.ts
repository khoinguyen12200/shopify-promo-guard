/**
 * See: docs/platform-admin-spec.md §13 (feature flags — controlled rollouts)
 *
 * Code calls `isEnabled(shopId, flagKey)`. Results cache for 60 seconds to
 * balance admin-UI responsiveness against DB load; §13 explicitly calls out
 * that toggle effects apply within 60s.
 */

import prisma from "../db.server.js";

const CACHE_TTL_MS = 60 * 1000;

type CacheEntry = { value: boolean; expiresAt: number };

/** Cache key: `${flagKey}:${shopId ?? "*"}`. */
const cache = new Map<string, CacheEntry>();

function cacheKey(flagKey: string, shopId: string | null): string {
  return `${flagKey}:${shopId ?? "*"}`;
}

function now(): number {
  return Date.now();
}

/** Exposed for tests — do not call from application code. */
export function __resetFeatureFlagCacheForTests(): void {
  cache.clear();
}

/**
 * Check whether a flag is enabled for the given shop. Shop-specific override
 * wins over the global default. Unknown flags return false.
 */
export async function isEnabled(
  flagKey: string,
  shopId: string | null,
): Promise<boolean> {
  const key = cacheKey(flagKey, shopId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.value;

  const flag = await prisma.featureFlag.findUnique({
    where: { key: flagKey },
    include: {
      overrides: shopId
        ? {
            where: { shopId },
            take: 1,
          }
        : { take: 0 },
    },
  });

  let value: boolean;
  if (!flag) {
    value = false;
  } else if (shopId && flag.overrides.length > 0) {
    value = flag.overrides[0].value;
  } else {
    value = flag.defaultValue;
  }

  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
}

/**
 * Set or clear a shop-specific override. Pass `value = null` to delete the
 * override and fall back to the flag default. Invalidates the cache entry
 * synchronously so the next read sees the new value (the 60s TTL from §13
 * is the upper bound for readers on OTHER processes).
 */
export async function setOverride(args: {
  flagKey: string;
  shopId: string;
  value: boolean | null;
  adminUserId?: string | null;
}): Promise<void> {
  const flag = await prisma.featureFlag.findUnique({
    where: { key: args.flagKey },
    select: { id: true },
  });
  if (!flag) {
    throw new Error(`feature flag "${args.flagKey}" does not exist`);
  }

  if (args.value === null) {
    await prisma.featureFlagOverride.deleteMany({
      where: { featureFlagId: flag.id, shopId: args.shopId },
    });
  } else {
    await prisma.featureFlagOverride.upsert({
      where: {
        featureFlagId_shopId: {
          featureFlagId: flag.id,
          shopId: args.shopId,
        },
      },
      update: {
        value: args.value,
        setByAdminId: args.adminUserId ?? null,
      },
      create: {
        featureFlagId: flag.id,
        shopId: args.shopId,
        value: args.value,
        setByAdminId: args.adminUserId ?? null,
      },
    });
  }
  cache.delete(cacheKey(args.flagKey, args.shopId));
}

/** Flip the default (applies to all shops without an override). */
export async function setDefault(args: {
  flagKey: string;
  value: boolean;
}): Promise<void> {
  await prisma.featureFlag.update({
    where: { key: args.flagKey },
    data: { defaultValue: args.value },
  });
  // Invalidate every cached entry for this flag — can't be surgical since
  // we don't track cache keys by flag. Clear the whole cache; correctness
  // over performance, and the 60s TTL bounds the refill cost anyway.
  for (const k of cache.keys()) {
    if (k.startsWith(`${args.flagKey}:`)) cache.delete(k);
  }
}
