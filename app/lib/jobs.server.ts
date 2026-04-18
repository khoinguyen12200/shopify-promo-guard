/**
 * See: docs/webhook-spec.md §8 (error handling + retry semantics)
 * Related: docs/webhook-spec.md §12 (file layout, worker process)
 *
 * Minimal table-backed job queue. The `Job` row is the single source of
 * truth; no Redis, no external broker. Workers poll with
 * `FOR UPDATE SKIP LOCKED` so multiple runners can share the queue safely.
 *
 * Scheduling note (no schema change possible in this task): we repurpose
 * `startedAt` as the "earliest run at" marker. The polling query only
 * picks rows where `startedAt IS NULL OR startedAt <= NOW()`, so a retry
 * with a future `startedAt` is simply invisible until its backoff elapses.
 * On successful claim we overwrite `startedAt = NOW()`.
 */

import type { Job } from "@prisma/client";

import prisma from "../db.server.js";

// -- Types ------------------------------------------------------------------

export interface JobHandlerCtx {
  jobId: string;
  shopId: string;
  /**
   * Update the job's `progress` (and optionally `total`). Handlers call this
   * during long-running work so the admin UI can render a progress bar.
   */
  updateProgress(done: number, total?: number): Promise<void>;
}

export type JobHandler<P = unknown> = (
  payload: P,
  ctx: JobHandlerCtx,
) => Promise<void>;

export type JobRegistry = Record<string, JobHandler<unknown>>;

// -- Constants --------------------------------------------------------------

/** Total number of attempts before a job is dead-lettered. */
export const MAX_ATTEMPTS = 5;

/** Base unit (ms) for exponential backoff. 2s matches webhook-spec §8. */
const BACKOFF_BASE_MS = 2_000;

/** Cap on backoff (5 minutes) to prevent absurd sleeps on a stuck handler. */
const BACKOFF_CAP_MS = 5 * 60 * 1_000;

/** Default number of jobs claimed per tick by a worker. */
const DEFAULT_BATCH_SIZE = 5;

/**
 * Exponential backoff schedule for retries.
 *   attempts=1 -> 4s
 *   attempts=2 -> 8s
 *   attempts=3 -> 16s
 *   attempts=4 -> 32s
 *   attempts=5 -> 64s (but we dead-letter at >= MAX_ATTEMPTS, so unused)
 *
 * Cap enforces a 5-minute ceiling.
 */
export function backoffMs(attempts: number): number {
  const safe = Math.max(0, Math.floor(attempts));
  const delay = BACKOFF_BASE_MS * 2 ** safe;
  return Math.min(delay, BACKOFF_CAP_MS);
}

// -- Public API -------------------------------------------------------------

export interface EnqueueJobParams {
  shopId: string;
  type: string;
  payload: unknown;
  total?: number;
}

/**
 * Insert a pending job row. Payload is JSON-stringified; the handler is
 * responsible for parsing it (type-safety lives at the handler boundary).
 */
export async function enqueueJob(params: EnqueueJobParams): Promise<Job> {
  const { shopId, type, payload, total } = params;
  return prisma.job.create({
    data: {
      shopId,
      type,
      payload: JSON.stringify(payload ?? null),
      total: total ?? 0,
      status: "pending",
    },
  });
}

export interface RunJobBatchOptions {
  batchSize?: number;
}

/**
 * One tick of the worker loop:
 *   1. Atomically claim up to `batchSize` runnable pending jobs.
 *   2. For each claimed job, look up its handler and await it.
 *   3. Update status to `complete`, or reschedule with backoff, or dead-letter.
 *
 * Returns the number of jobs processed (success OR terminal failure).
 * A zero return tells the caller nothing is runnable right now — sleep and
 * try again.
 */
export async function runJobBatch(
  registry: JobRegistry,
  opts: RunJobBatchOptions = {},
): Promise<number> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));

  // Claim atomically. The `FOR UPDATE SKIP LOCKED` clause is the key trick:
  // two workers running this simultaneously never see the same row.
  const claimed = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
       SET "status" = 'running', "startedAt" = NOW()
     WHERE id IN (
       SELECT id FROM "Job"
        WHERE "status" = 'pending'
          AND ("startedAt" IS NULL OR "startedAt" <= NOW())
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
     )
     RETURNING *;
  `;

  if (claimed.length === 0) return 0;

  let processed = 0;
  for (const job of claimed) {
    await runOneJob(job, registry);
    processed += 1;
  }
  return processed;
}

// -- Internals --------------------------------------------------------------

async function runOneJob(job: Job, registry: JobRegistry): Promise<void> {
  const handler = registry[job.type];

  // Unknown job type: fail fast. Don't retry — the code will still be missing
  // on the next run. Treat as dead-letter so an operator notices.
  if (!handler) {
    await markFailed(
      job,
      new Error(`no handler registered for job type "${job.type}"`),
      /* forceDeadLetter */ true,
    );
    return;
  }

  const payload = safeParseJSON(job.payload);

  const ctx: JobHandlerCtx = {
    jobId: job.id,
    shopId: job.shopId,
    updateProgress: async (done: number, total?: number) => {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          progress: done,
          ...(total !== undefined ? { total } : {}),
        },
      });
    },
  };

  try {
    await handler(payload, ctx);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "complete",
        completedAt: new Date(),
        error: null,
      },
    });
  } catch (err) {
    await markFailed(job, err);
  }
}

/**
 * Handle a thrown handler: either reschedule with backoff (pending + future
 * startedAt) or mark the job dead-letter (status="failed"). `forceDeadLetter`
 * skips the retry path for unrecoverable conditions (missing handler, etc).
 */
async function markFailed(
  job: Job,
  err: unknown,
  forceDeadLetter = false,
): Promise<void> {
  const message = errorToString(err);
  const nextAttempts = job.attempts + 1;

  if (!forceDeadLetter && nextAttempts < MAX_ATTEMPTS) {
    const nextRunAt = new Date(Date.now() + backoffMs(nextAttempts));
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "pending",
        attempts: nextAttempts,
        error: message,
        startedAt: nextRunAt,
      },
    });
    return;
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: "failed",
      attempts: nextAttempts,
      error: message,
      completedAt: new Date(),
    },
  });
}

function safeParseJSON(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed payload — pass the raw string through so the handler can
    // decide what to do. We intentionally do not throw here; throwing would
    // retry, but the payload won't parse on the next run either.
    return raw;
  }
}

function errorToString(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
