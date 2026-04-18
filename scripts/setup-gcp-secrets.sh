#!/usr/bin/env bash
# See: CLAUDE.md § Infrastructure (Secret Manager)
# Idempotent setup for every secret that Cloud Run binds at deploy time.
#
# Usage:
#   ./scripts/setup-gcp-secrets.sh <PROJECT_ID>
#
# For each secret, the script:
#   - creates it if missing (gcloud secrets create)
#   - prompts for the value if the "latest" version doesn't exist yet
#   - grants the Cloud Run runtime SA the secretAccessor role
#
# Re-running is safe — each step no-ops when the state is already correct.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <PROJECT_ID>" >&2
  exit 1
fi

PROJECT_ID="$1"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

SECRETS=(
  "promo-guard-database-url"
  "promo-guard-direct-database-url"
  "promo-guard-shopify-api-key"
  "promo-guard-shopify-api-secret"
  "promo-guard-app-kek-hex"
  "promo-guard-session-secret"
  "promo-guard-magic-link-secret"
  "promo-guard-platform-admin-allowed-emails"
)

ensure_secret() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "→ creating secret: $name"
    gcloud secrets create "$name" \
      --project="$PROJECT_ID" \
      --replication-policy="automatic"
  else
    echo "✓ secret exists: $name"
  fi
}

ensure_version() {
  local name="$1"
  if gcloud secrets versions list "$name" --project="$PROJECT_ID" --limit=1 \
    --filter='state=ENABLED' --format='value(name)' | grep -q .; then
    echo "✓ version exists: $name"
    return
  fi
  echo
  echo "── $name ──────────────────────────────────────────"
  echo "Paste value (single line), then press Enter. Ctrl+C to skip."
  read -r -s VALUE
  printf "%s" "$VALUE" | \
    gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=-
  echo "✓ version added: $name"
}

grant_accessor() {
  local name="$1"
  gcloud secrets add-iam-policy-binding "$name" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role='roles/secretmanager.secretAccessor' \
    --quiet >/dev/null
}

for s in "${SECRETS[@]}"; do
  ensure_secret "$s"
  ensure_version "$s"
  grant_accessor "$s"
done

echo
echo "Done. Runtime SA ${RUNTIME_SA} can read all ${#SECRETS[@]} secrets."
