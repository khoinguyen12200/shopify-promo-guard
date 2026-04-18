/**
 * See: CLAUDE.md § Commands (make verify)
 * Related: app/lib/env.server.ts (single env reader)
 *
 * Vitest setup: load .env so env.server.ts can parse it and assert the
 * two vars this batch of tests actually needs before any test module
 * is imported.
 */

import "dotenv/config";

const REQUIRED = ["DATABASE_URL", "APP_KEK_HEX"] as const;

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(
      `Missing required env var ${key} for tests. Ensure .env is present ` +
        `(copy .env.example and run 'make setup' — see CLAUDE.md).`,
    );
  }
}
