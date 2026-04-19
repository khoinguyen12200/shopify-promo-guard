/**
 * See: app/jobs/retention-cleanup.ts (the per-shop handler),
 *      INFRA.md → "Scheduled jobs (Cloud Scheduler)" (gcloud setup).
 *
 * Fanout endpoint hit by Cloud Scheduler (or local curl) once a day.
 * For every active shop, enqueue one `retention_cleanup` job. The worker
 * picks them up from the Job table and runs the deletes.
 *
 * Auth: shared secret in `X-Cron-Secret` header. Compared via constant-
 * time so a timing oracle can't tease out the secret one byte at a time.
 *
 * Idempotency: enqueueing a fresh job per tick is fine — the job table
 * has no uniqueness on (shopId, type) so a re-trigger just stacks up
 * extra deletes. Each handler reads the current cutoff and is a no-op
 * once the rows are gone, so duplicate runs are cheap and safe.
 *
 * HTTP semantics:
 *   - 401 if X-Cron-Secret missing/wrong
 *   - 405 for GET (this is a POST-only fanout)
 *   - 200 with a `{ enqueued, skipped }` JSON body on success
 */

import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server.js";
import { env } from "~/lib/env.server.js";
import { enqueueJob } from "~/lib/jobs.server.js";

function constantTimeStringEqual(a: string, b: string): boolean {
  // Buffers must be the same length for timingSafeEqual; pad the shorter.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against a same-length buffer to keep the work constant
    // before returning false. Avoids early-exit timing leak on length.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

export const loader = async () => {
  // GETs are explicitly disallowed — Cloud Scheduler always POSTs, and
  // returning a payload on GET would be an accidental info leak.
  return new Response("method not allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeStringEqual(provided, env.CRON_SECRET)) {
    console.warn("[cron.retention] rejected: bad/missing X-Cron-Secret");
    return unauthorized();
  }

  // Only fan out to active shops. Uninstalled shops are on the
  // shop/redact wholesale-delete path, so retention cleanup is moot.
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true, shopDomain: true },
  });

  let enqueued = 0;
  for (const shop of shops) {
    try {
      await enqueueJob({
        shopId: shop.id,
        type: "retention_cleanup",
        payload: {},
      });
      enqueued += 1;
    } catch (err) {
      console.error(
        `[cron.retention] failed to enqueue for ${shop.shopDomain}:`,
        err,
      );
      // Keep going — one bad shop shouldn't block the rest.
    }
  }

  console.log(
    `[cron.retention] fanout complete: ${enqueued}/${shops.length} jobs enqueued`,
  );

  return Response.json({
    ok: true,
    enqueued,
    total: shops.length,
  });
};
