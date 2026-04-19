/**
 * See: docs/database-design.md (Shop.retentionDays),
 *      app/routes/cron.retention.tsx (the fanout endpoint)
 *
 * Per-shop retention enforcement. Cloud Scheduler (or local cron) hits
 * /cron/retention daily; that endpoint enqueues one `retention_cleanup`
 * job per active shop, and the worker dispatches each here.
 *
 * What it does:
 *   - Reads shop.retentionDays (default 365). If 0/null, treats as
 *     unlimited and skips deletion.
 *   - DELETEs RedemptionRecord rows older than (now - retentionDays days).
 *   - Logs the cutoff + count for ops visibility.
 *
 * What it deliberately does NOT touch:
 *   - FlaggedOrder rows: those are operational signals merchants act on,
 *     not silent telemetry. They follow merchant intent, not retention.
 *   - Job, WebhookEvent, AuditLog rows: separate retention story (these
 *     are auditing infra, not customer PII).
 *   - Shop-wide shard metafield: rebuilt on the next shard_append; we
 *     don't pre-emptively rewrite it from here.
 *
 * Deletion semantics: prisma.deleteMany on a RedemptionRecord composite
 * index by (shopId, createdAt) — fast on the hot path index. We're not
 * scrubbing the encrypted plaintext separately because the row itself is
 * gone (no orphan ciphertext lives anywhere else).
 */

import prisma from "../db.server.js";
import type { JobHandler } from "../lib/jobs.server.js";

export interface RetentionCleanupPayload {
  /** Optional override (testing / one-off backfills); falls back to shop.retentionDays. */
  retentionDaysOverride?: number;
}

export const handleRetentionCleanup: JobHandler<
  RetentionCleanupPayload
> = async (payload, ctx) => {
  const shop = await prisma.shop.findUnique({
    where: { id: ctx.shopId },
    select: {
      id: true,
      shopDomain: true,
      retentionDays: true,
      uninstalledAt: true,
    },
  });
  if (!shop) {
    // Shop got purged between fanout and dispatch — nothing to do.
    return;
  }
  if (shop.uninstalledAt) {
    // Uninstalled shops are on the `shop/redact` cleanup path; don't
    // also hit them with retention deletes (they'll be wiped wholesale
    // ~48h post-uninstall anyway).
    return;
  }

  const days = payload?.retentionDaysOverride ?? shop.retentionDays;
  if (!days || days <= 0) {
    console.log(
      `[retention_cleanup] ${shop.shopDomain}: retentionDays=${days} — unlimited, skipping`,
    );
    return;
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.redemptionRecord.deleteMany({
    where: {
      shopId: shop.id,
      createdAt: { lt: cutoff },
    },
  });

  console.log(
    `[retention_cleanup] ${shop.shopDomain}: deleted ${result.count} RedemptionRecord rows older than ${cutoff.toISOString()} (${days}d retention)`,
  );
};
