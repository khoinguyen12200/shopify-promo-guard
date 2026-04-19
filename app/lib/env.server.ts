/**
 * See: CLAUDE.md § Infrastructure (env var contract)
 * Single source of truth for environment variables. Every other
 * module reads from here — never from process.env directly.
 */

import { z } from "zod";

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

const envSchema = z.object({
  // Postgres connection strings — pooled for app, unpooled for migrations.
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres connection URL",
    ),
  DIRECT_DATABASE_URL: z
    .string()
    .min(1, "DIRECT_DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DIRECT_DATABASE_URL must be a postgres connection URL",
    ),

  // Shopify app credentials (from Partner Dashboard).
  SHOPIFY_API_KEY: z.string().min(1, "SHOPIFY_API_KEY is required"),
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),
  SHOPIFY_APP_URL: z.string().url("SHOPIFY_APP_URL must be a valid URL"),
  SCOPES: z.string().optional(),
  SHOP_CUSTOM_DOMAIN: z.string().optional(),

  // Secrets — 32 random bytes encoded as 64 hex chars (openssl rand -hex 32).
  APP_KEK_HEX: z
    .string()
    .regex(HEX_32_BYTES, "APP_KEK_HEX must be 64 hex chars (32 bytes)"),
  SESSION_SECRET: z
    .string()
    .regex(HEX_32_BYTES, "SESSION_SECRET must be 64 hex chars (32 bytes)"),
  MAGIC_LINK_SECRET: z
    .string()
    .regex(HEX_32_BYTES, "MAGIC_LINK_SECRET must be 64 hex chars (32 bytes)"),

  // Comma-separated allowlist of emails permitted to access /admin.*.
  PLATFORM_ADMIN_ALLOWED_EMAILS: z
    .string()
    .min(1, "PLATFORM_ADMIN_ALLOWED_EMAILS is required"),

  // Worker tuning (optional, default 2000ms poll).
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

  // Optional debug flag for Admin GraphQL cost logging.
  DEBUG_GQL: z.enum(["0", "1"]).default("0"),

  // Shared secret for authenticating cron-triggered requests.
  CRON_SECRET: z.string().min(1).default(""),

  // Standard Node environment.
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  // Build a human-readable, multi-line error listing every offending key.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");

  throw new Error(
    `Invalid environment configuration — fix these and restart:\n${issues}\n` +
      `(See .env.example for the full contract.)`,
  );
}

/**
 * Frozen, validated env. Throws at module-load time if anything is missing
 * or malformed — first import asserts the contract.
 */
export const env: Readonly<Env> = Object.freeze(parseEnv(process.env));
