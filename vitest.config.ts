/**
 * See: CLAUDE.md § Commands (make verify runs Vitest)
 * Related: docs/build-orchestration-spec.md
 *
 * Base Vitest config — Node environment, loads .env via setup file,
 * only picks up *.test.ts beside the code it exercises.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["app/**/*.test.ts"],
    setupFiles: ["./app/test-setup.ts"],
    // Tests touch a live Postgres (localhost:5434) + use real crypto —
    // serialize to avoid cross-test DB contention and flaky runs.
    pool: "forks",
    fileParallelism: false,
  },
});
