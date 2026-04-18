/**
 * See: docs/webhook-spec.md §12 (worker process)
 * Related: docs/webhook-spec.md §8 (retry + dead-letter)
 *
 * Runs via `npm run worker`. Cloud Run / local dev. A single long-lived Node
 * process that polls the `Job` table and dispatches to registered handlers.
 *
 * Handlers register themselves here as later tasks add them (T18 shard-append,
 * T21 compliance-redact, T42 cold-start is live). For T15 we shipped the
 * skeleton with an empty registry — unknown job types dead-letter immediately,
 * which is the correct failure mode if production sees one before handlers
 * are wired.
 */

import "dotenv/config";

import { handleColdStart } from "../jobs/cold-start.js";
import { handleAppUninstalled } from "../jobs/handle-app-uninstalled.js";
import { handleComplianceShopRedact } from "../jobs/compliance-shop-redact.js";
import { handleOrdersPaid } from "../jobs/handle-orders-paid.js";
import { handleShardAppend } from "../jobs/shard-append.js";
import { runJobBatch, type JobRegistry } from "../lib/jobs.server.js";

const registry: JobRegistry = {
  app_uninstalled: handleAppUninstalled as JobRegistry[string],
  cold_start: handleColdStart as JobRegistry[string],
  compliance_shop_redact: handleComplianceShopRedact as JobRegistry[string],
  orders_paid: handleOrdersPaid as JobRegistry[string],
  shard_append: handleShardAppend as JobRegistry[string],
};

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);

async function main(): Promise<void> {
  console.log(`[worker] starting, poll=${POLL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const n = await runJobBatch(registry, { batchSize: 5 });
      if (n === 0) await sleep(POLL_MS);
    } catch (err) {
      console.error("[worker] batch error", err);
      await sleep(POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
