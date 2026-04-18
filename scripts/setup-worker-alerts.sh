#!/usr/bin/env bash
# See: docs/webhook-spec.md §12 (worker deploy alerts)
# Creates a Cloud Monitoring alert policy that pages when the
# promo-guard-worker Cloud Run service logs an error for N consecutive
# minutes. Requires `gcloud alpha monitoring` and a configured notification
# channel.
#
# Usage:
#   ./scripts/setup-worker-alerts.sh <PROJECT_ID> <NOTIFICATION_CHANNEL_ID>
#
# Where NOTIFICATION_CHANNEL_ID is the numeric ID of an existing channel
# from `gcloud alpha monitoring channels list`. Create one first via the
# Cloud Console or `gcloud alpha monitoring channels create`.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <PROJECT_ID> <NOTIFICATION_CHANNEL_ID>" >&2
  exit 1
fi

PROJECT_ID="$1"
CHANNEL_ID="$2"
POLICY_NAME="promo-guard-worker-error-rate"

POLICY_JSON="$(cat <<JSON
{
  "displayName": "${POLICY_NAME}",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "promo-guard-worker: any ERROR in last 5m",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"promo-guard-worker\" AND severity = \"ERROR\" AND metric.type = \"logging.googleapis.com/log_entry_count\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "300s",
        "aggregations": [
          {
            "alignmentPeriod": "60s",
            "perSeriesAligner": "ALIGN_SUM"
          }
        ]
      }
    }
  ],
  "notificationChannels": ["projects/${PROJECT_ID}/notificationChannels/${CHANNEL_ID}"],
  "alertStrategy": {
    "autoClose": "3600s"
  }
}
JSON
)"

TMP="$(mktemp)"
trap "rm -f $TMP" EXIT
printf "%s" "$POLICY_JSON" > "$TMP"

# Find an existing policy with the same displayName and update it; otherwise
# create fresh. Keeps the script idempotent.
EXISTING_NAME="$(
  gcloud alpha monitoring policies list \
    --project="$PROJECT_ID" \
    --filter="displayName=\"${POLICY_NAME}\"" \
    --format='value(name)' | head -n1
)"

if [ -n "$EXISTING_NAME" ]; then
  echo "→ updating existing alert policy: $EXISTING_NAME"
  gcloud alpha monitoring policies update "$EXISTING_NAME" \
    --project="$PROJECT_ID" \
    --policy-from-file="$TMP"
else
  echo "→ creating alert policy: $POLICY_NAME"
  gcloud alpha monitoring policies create \
    --project="$PROJECT_ID" \
    --policy-from-file="$TMP"
fi

echo "Done."
