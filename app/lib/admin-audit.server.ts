/**
 * See: docs/platform-admin-spec.md §2 (audit log)
 * Related: docs/platform-admin-spec.md §14 (audit search UI)
 *
 * Every mutating admin action calls `logAdminAction`. The log is append-only
 * — the UI never offers a delete path and the table is retained for 3 years.
 * Never pass decrypted PII into `metadata`; the audit log is structured and
 * scrubbed, not a free-form dump.
 */

import prisma from "../db.server.js";

export interface LogAdminActionParams {
  /**
   * The admin performing the action. Null is allowed for login-attempt-style
   * events where we haven't resolved a user yet (e.g. magic-link request with
   * a disallowed email — we still want the attempt trail).
   */
  adminUserId?: string | null;
  /** Short verb, lowercase + underscored: "login", "view_pii", "impersonate". */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Serialized as JSON. Caller is responsible for not passing PII. */
  metadata?: unknown;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Write one AdminAuditLog row. Swallows errors at the boundary of a "fire and
 * forget" audit write — a logging failure must never break the user-facing
 * action. We log to stderr so an operator still notices.
 */
export async function logAdminAction(params: LogAdminActionParams): Promise<void> {
  const {
    adminUserId = null,
    action,
    targetType,
    targetId,
    metadata,
    ipAddress,
    userAgent,
  } = params;

  try {
    await prisma.adminAuditLog.create({
      data: {
        adminUserId: adminUserId ?? null,
        action,
        targetType: targetType ?? null,
        targetId: targetId ?? null,
        metadata: metadata === undefined ? null : JSON.stringify(metadata),
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[admin-audit] failed to write audit log", {
      action,
      targetType,
      targetId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
