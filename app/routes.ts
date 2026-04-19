/**
 * Explicit route definitions — replaces flatRoutes() so route files can live
 * in clean nested directories instead of dot-separated flat filenames.
 *
 * route(path, file, children?)  – URL segment + component (layout if children)
 * index(file)                   – index route at the parent URL
 * layout(file, children)        – pathless layout (no URL segment added)
 */
import { route, index, layout } from "@react-router/dev/routes";

export default [
  // ── Auth (Shopify-managed) ──────────────────────────────────────────────
  route("auth/login", "routes/auth.login/route.tsx"),
  route("auth/*", "routes/auth.$.tsx"),

  // ── Public marketing site ───────────────────────────────────────────────
  layout("routes/_public.tsx", [
    index("routes/_public/_index.tsx"),
    route("install",  "routes/_public/install.tsx"),
    route("pricing",  "routes/_public/pricing.tsx"),
    route("privacy",  "routes/_public/privacy.tsx"),
    route("security", "routes/_public/security.tsx"),
    route("terms",    "routes/_public/terms.tsx"),
  ]),

  // ── Platform admin ──────────────────────────────────────────────────────
  route("admin", "routes/admin.tsx", [
    index("routes/admin/_index.tsx"),
    route("audit",         "routes/admin/audit.tsx"),
    route("compliance",    "routes/admin/compliance.tsx"),
    route("dead-letters",  "routes/admin/dead-letters.tsx"),
    route("feature-flags", "routes/admin/feature-flags.tsx"),
    route("jobs",          "routes/admin/jobs.tsx"),
    route("login",         "routes/admin/login.tsx"),
    route("logout",        "routes/admin/logout.tsx"),
    route("metrics",       "routes/admin/metrics.tsx"),
    route("shops",         "routes/admin/shops/_index.tsx"),
    route("shops/:id",             "routes/admin/shops/$id/_index.tsx"),
    route("shops/:id/impersonate", "routes/admin/shops/$id/impersonate.tsx"),
    route("shops/:id/redemptions", "routes/admin/shops/$id/redemptions.tsx"),
  ]),

  // ── Embedded merchant app ───────────────────────────────────────────────
  route("app", "routes/app.tsx", [
    index("routes/app/_index.tsx"),
    route("onboarding", "routes/app/onboarding.tsx"),
    route("settings",   "routes/app/settings.tsx"),
    route("flagged",    "routes/app/flagged/_index.tsx"),
    route("offers",     "routes/app/offers/_index.tsx"),
    route("offers/new",           "routes/app/offers/new.tsx"),
    route("offers/:id",           "routes/app/offers/$id/_index.tsx"),
    route("offers/:id/edit",      "routes/app/offers/$id/edit.tsx"),
    route("offers/:id/delete",    "routes/app/offers/$id/delete.tsx"),
  ]),

  // ── API ─────────────────────────────────────────────────────────────────
  route("api/flagged-order", "routes/api/flagged-order.tsx"),

  // ── Webhooks ────────────────────────────────────────────────────────────
  route("webhooks/_test",                   "routes/webhooks/_test.tsx"),
  route("webhooks/app/scopes_update",       "routes/webhooks/app/scopes_update.tsx"),
  route("webhooks/app/uninstalled",         "routes/webhooks/app/uninstalled.tsx"),
  route("webhooks/customers/data_request",  "routes/webhooks/customers/data_request.tsx"),
  route("webhooks/customers/redact",        "routes/webhooks/customers/redact.tsx"),
  route("webhooks/orders/paid",             "routes/webhooks/orders/paid.tsx"),
  route("webhooks/shop/redact",             "routes/webhooks/shop/redact.tsx"),

  // ── Cron ────────────────────────────────────────────────────────────────
  route("cron/retention", "routes/cron/retention.tsx"),
];
