/**
 * See: docs/webhook-spec.md §8 + §12
 * Related: app/lib/jobs.server.ts
 *
 * Integration tests against the real dev Postgres (localhost:5434).
 * Each test seeds its own shop via ensureShop with a unique domain to
 * avoid cross-test contention (mirrors app/lib/shop.test.ts).
 */

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import prisma from "../db.server.js";
import {
  backoffMs,
  enqueueJob,
  MAX_ATTEMPTS,
  runJobBatch,
  type JobHandler,
  type JobRegistry,
} from "./jobs.server.js";
import { ensureShop } from "./shop.server.js";

const createdDomains: string[] = [];

function uniqueDomain(tag: string): string {
  const suffix = randomBytes(6).toString("hex");
  const domain = `test-jobs-${tag}-${suffix}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

async function seedShopId(tag: string): Promise<string> {
  const shop = await ensureShop({
    shopDomain: uniqueDomain(tag),
    accessToken: "token",
    scope: "read_orders",
  });
  return shop.id;
}

/**
 * Clear a job's backoff so the next runJobBatch picks it up immediately.
 * Mirrors "time has passed" without actually sleeping.
 */
async function clearBackoff(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { startedAt: null },
  });
}

afterAll(async () => {
  if (createdDomains.length > 0) {
    // Jobs cascade-delete via Shop.onDelete: Cascade.
    await prisma.shop.deleteMany({
      where: { shopDomain: { in: createdDomains } },
    });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("enqueueJob", () => {
  it("inserts a row with status='pending' and zeroed counters", async () => {
    const shopId = await seedShopId("enqueue");
    const job = await enqueueJob({
      shopId,
      type: "test:noop",
      payload: { hello: "world" },
      total: 3,
    });

    expect(job.shopId).toBe(shopId);
    expect(job.type).toBe("test:noop");
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.progress).toBe(0);
    expect(job.total).toBe(3);
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    // Payload is JSON-stringified.
    expect(JSON.parse(job.payload)).toEqual({ hello: "world" });
  });
});

// ---------------------------------------------------------------------------

describe("runJobBatch — success path", () => {
  it("runs the handler, marks the job complete, and sets completedAt", async () => {
    const shopId = await seedShopId("success");

    const calls: Array<{ payload: unknown; shopId: string; jobId: string }> =
      [];
    const registry: JobRegistry = {
      "test:ok": (async (payload, ctx) => {
        calls.push({ payload, shopId: ctx.shopId, jobId: ctx.jobId });
      }) as JobHandler,
    };

    const enqueued = await enqueueJob({
      shopId,
      type: "test:ok",
      payload: { n: 42 },
    });

    const processed = await runJobBatch(registry, { batchSize: 10 });
    expect(processed).toBeGreaterThanOrEqual(1);

    const row = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(row.status).toBe("complete");
    expect(row.attempts).toBe(0);
    expect(row.completedAt).not.toBeNull();
    expect(row.error).toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.jobId).toBe(enqueued.id);
    expect(calls[0]!.shopId).toBe(shopId);
    expect(calls[0]!.payload).toEqual({ n: 42 });
  });

  it("updateProgress persists progress and total", async () => {
    const shopId = await seedShopId("progress");

    const registry: JobRegistry = {
      "test:progress": (async (_payload, ctx) => {
        await ctx.updateProgress(2, 10);
      }) as JobHandler,
    };

    const enqueued = await enqueueJob({
      shopId,
      type: "test:progress",
      payload: null,
    });

    await runJobBatch(registry, { batchSize: 10 });

    const row = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(row.progress).toBe(2);
    expect(row.total).toBe(10);
    expect(row.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------

describe("runJobBatch — retry path", () => {
  it("retries a handler that throws once, then succeeds", async () => {
    const shopId = await seedShopId("retry-once");

    let callCount = 0;
    const registry: JobRegistry = {
      "test:flaky": (async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("transient boom");
      }) as JobHandler,
    };

    const enqueued = await enqueueJob({
      shopId,
      type: "test:flaky",
      payload: {},
    });

    // First run: handler throws. Job should be rescheduled (status=pending,
    // attempts=1, startedAt in the future).
    await runJobBatch(registry, { batchSize: 10 });
    const afterFirst = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.error).toContain("transient boom");
    expect(afterFirst.startedAt).not.toBeNull();
    expect(afterFirst.startedAt!.getTime()).toBeGreaterThan(Date.now());

    // Simulate backoff elapsing, then run again.
    await clearBackoff(enqueued.id);
    await runJobBatch(registry, { batchSize: 10 });

    const afterSecond = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(afterSecond.status).toBe("complete");
    expect(afterSecond.attempts).toBe(1); // success doesn't bump attempts
    expect(afterSecond.completedAt).not.toBeNull();
    expect(callCount).toBe(2);
  });

  it("does NOT pick up a job whose backoff has not yet elapsed", async () => {
    const shopId = await seedShopId("backoff-gate");

    const registry: JobRegistry = {
      "test:always-fail": (async () => {
        throw new Error("nope");
      }) as JobHandler,
    };

    const enqueued = await enqueueJob({
      shopId,
      type: "test:always-fail",
      payload: {},
    });

    // First run marks attempts=1 with startedAt in the future.
    await runJobBatch(registry, { batchSize: 10 });
    const after = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(1);
    expect(after.startedAt!.getTime()).toBeGreaterThan(Date.now());

    // Second immediate run must NOT pick it up — the backoff gate is intact.
    const processed = await runJobBatch(registry, { batchSize: 10 });
    // We may or may not process other jobs in the table from prior tests, but
    // _this_ job's attempts count must not have been bumped.
    const afterNoop = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(afterNoop.attempts).toBe(1);
    expect(afterNoop.status).toBe("pending");
    // Sanity: nothing with this job type should have been claimed.
    void processed;
  });
});

// ---------------------------------------------------------------------------

describe("runJobBatch — dead-letter path", () => {
  it(`marks the job failed after ${MAX_ATTEMPTS} attempts`, async () => {
    const shopId = await seedShopId("dead-letter");

    const registry: JobRegistry = {
      "test:always-fail-dl": (async () => {
        throw new Error("permanent boom");
      }) as JobHandler,
    };

    const enqueued = await enqueueJob({
      shopId,
      type: "test:always-fail-dl",
      payload: {},
    });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await clearBackoff(enqueued.id);
      await runJobBatch(registry, { batchSize: 10 });
    }

    const final = await prisma.job.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(MAX_ATTEMPTS);
    expect(final.error).toContain("permanent boom");
    expect(final.completedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("runJobBatch — concurrent claim", () => {
  it("two concurrent callers see disjoint job sets", async () => {
    const shopId = await seedShopId("concurrent");

    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const job = await enqueueJob({
        shopId,
        type: "test:concurrent",
        payload: { i },
      });
      ids.add(job.id);
    }

    // Handler that sleeps briefly to keep both batches "in flight" long
    // enough to prove the claim is exclusive.
    const seenA: string[] = [];
    const seenB: string[] = [];
    const registryA: JobRegistry = {
      "test:concurrent": (async (_payload, ctx) => {
        seenA.push(ctx.jobId);
        await new Promise((r) => setTimeout(r, 20));
      }) as JobHandler,
    };
    const registryB: JobRegistry = {
      "test:concurrent": (async (_payload, ctx) => {
        seenB.push(ctx.jobId);
        await new Promise((r) => setTimeout(r, 20));
      }) as JobHandler,
    };

    const [a, b] = await Promise.all([
      runJobBatch(registryA, { batchSize: 10 }),
      runJobBatch(registryB, { batchSize: 10 }),
    ]);

    // Every job we enqueued in this test must have been claimed exactly once
    // across the two batches.
    const union = new Set<string>([...seenA, ...seenB]);
    for (const id of ids) expect(union.has(id)).toBe(true);

    // No overlap between the two workers.
    const overlap = seenA.filter((id) => seenB.includes(id));
    expect(overlap).toEqual([]);

    // Total processed (for our enqueued ids) equals the number we enqueued.
    const ours = [...seenA, ...seenB].filter((id) => ids.has(id));
    expect(ours).toHaveLength(ids.size);

    // Sanity: both calls reported processing at least one job each side
    // (not strictly guaranteed, but the sum should cover our ids).
    expect(a + b).toBeGreaterThanOrEqual(ids.size);
  });
});

// ---------------------------------------------------------------------------

describe("backoffMs", () => {
  it("is monotonic non-decreasing and capped at 5 minutes", () => {
    const values: number[] = [];
    for (let i = 0; i <= 20; i += 1) values.push(backoffMs(i));

    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }
    // Cap at 5 minutes.
    for (const v of values) expect(v).toBeLessThanOrEqual(5 * 60 * 1000);
    // Large attempts saturate at the cap.
    expect(backoffMs(50)).toBe(5 * 60 * 1000);
    // attempts=0 → base 2s.
    expect(backoffMs(0)).toBe(2000);
    // attempts=1 → 4s.
    expect(backoffMs(1)).toBe(4000);
  });
});
