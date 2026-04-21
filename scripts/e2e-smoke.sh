#!/usr/bin/env bash
# See: docs/landing-page-spec.md §15 · docs/platform-admin-spec.md §21
#
# Post-deploy smoke test — human-assisted. Runs the automated checks it can
# (landing page, admin login form, webhook signature path) and walks the
# operator through the steps that require a browser + dev store.
#
# Usage:
#   ./scripts/e2e-smoke.sh <APP_URL> <DEV_STORE_SUBDOMAIN>
# Example:
#   ./scripts/e2e-smoke.sh https://promo-guard-ssr-xyz.run.app test-store-7

set -uo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <APP_URL> <DEV_STORE_SUBDOMAIN>" >&2
  exit 1
fi

APP_URL="${1%/}"
DEV_STORE="$2"
PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

hr() { echo; echo "── $1 ──────────────────────────────────"; }

# 1. Public landing
hr "1. Public surface"
if curl -sf "${APP_URL}/" -o /dev/null; then
  pass "GET / returns 200"
else
  fail "GET / failed"
fi
for path in /pricing /privacy /security /terms /install; do
  if curl -sf "${APP_URL}${path}" -o /dev/null; then
    pass "GET ${path} returns 200"
  else
    fail "GET ${path} failed"
  fi
done

# 2. Install redirect
hr "2. Install flow"
redirect="$(curl -sI "${APP_URL}/install?shop=${DEV_STORE}.myshopify.com" | awk '/^[Ll]ocation:/ {print $2}' | tr -d '\r')"
if echo "$redirect" | grep -q "/auth"; then
  pass "valid shop domain redirects to /auth"
else
  fail "install redirect was '$redirect'"
fi

invalid_status="$(curl -so /dev/null -w '%{http_code}' "${APP_URL}/install?shop=not-a-real-domain")"
if [ "$invalid_status" = "200" ]; then
  pass "invalid shop domain stays on /install with inline error"
else
  fail "invalid shop domain HTTP status was $invalid_status"
fi

# 3. Platform admin login form
hr "3. Platform admin login"
login_status="$(curl -so /dev/null -w '%{http_code}' "${APP_URL}/admin/login")"
if [ "$login_status" = "200" ]; then
  pass "GET /admin/login returns 200 (magic-link form)"
else
  fail "GET /admin/login HTTP status $login_status"
fi
dashboard_status="$(curl -so /dev/null -w '%{http_code}' "${APP_URL}/admin")"
if [ "$dashboard_status" = "302" ] || [ "$dashboard_status" = "303" ]; then
  pass "unauthenticated GET /admin redirects (to /admin/login)"
else
  fail "unauthenticated GET /admin HTTP status $dashboard_status (expected 302/303)"
fi

# 4. Webhook endpoint rejects unsigned requests
hr "4. Webhook signature enforcement"
unsigned_status="$(
  curl -so /dev/null -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    -d '{"test":true}' \
    "${APP_URL}/webhooks/orders/paid"
)"
if [ "$unsigned_status" = "401" ] || [ "$unsigned_status" = "403" ]; then
  pass "unsigned webhook rejected ($unsigned_status)"
else
  fail "unsigned webhook returned $unsigned_status (expected 401/403)"
fi

# 5. Manual steps the operator must run in a browser
hr "5. Manual walkthrough (browser + dev store)"
cat <<'MANUAL'
  [ ] Install: Partner dashboard → install on ${DEV_STORE}.myshopify.com.
  [ ] OAuth: accept scopes. Land on /app.
  [ ] Onboarding: follow first-run prompts.
  [ ] Create offer: /app/offers/new → pick a welcome code from the list.
  [ ] Test block: place a test order in the dev store with a matching
      phone/email → confirm checkout is blocked at validation.
  [ ] Flag visibility: /app/flagged shows the new flag.
  [ ] Admin block: open the native order-details page in Shopify admin.
      The Promo Guard block renders the flag + dismiss/cancel actions.
  [ ] Uninstall: Partner dashboard → uninstall.
  [ ] Data retention: verify Shop row still present with uninstalledAt set;
      re-check again after 48h that purge has NOT yet run (compliance §).
  [ ] Platform admin: magic-link login → /admin renders dashboard numbers.
MANUAL

hr "Summary"
echo "  automated: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
