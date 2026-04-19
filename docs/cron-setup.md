# Scheduled jobs (Cloud Scheduler)

Promo Guard runs periodic work via **HTTP fanout endpoints** triggered by
**Google Cloud Scheduler**. The pattern: Scheduler hits a `/cron/*` route
with a shared secret in the `X-Cron-Secret` header; the route enqueues
one `Job` row per active shop; the existing worker process picks them up
and dispatches to the registered handler.

This keeps timing concerns (when to run) separate from work concerns
(what to do per shop) and lets us add new periodic jobs without touching
the worker.

## Endpoints

| Path | Method | Schedule | Per-shop job |
|------|--------|----------|--------------|
| `/cron/retention` | POST | daily 02:00 UTC | `retention_cleanup` |

To add a new endpoint: copy `app/routes/cron.retention.tsx`, point it at
a different `enqueueJob` type, register the handler in
`app/workers/worker.ts`, then add a Scheduler job for it.

## Auth

`X-Cron-Secret: <CRON_SECRET>` — compared against `env.CRON_SECRET`
using `crypto.timingSafeEqual`. Wrong/missing secret → 401.

Generate the secret once:

```bash
openssl rand -hex 32
```

Store as `CRON_SECRET` in Google Secret Manager. Reference it from both
Cloud Run (the app) and Cloud Scheduler (the trigger).

## GCP setup (production)

Run these once per environment. Replace `$PROJECT`, `$REGION`, and
`$SERVICE_URL` with your values.

### 1. Store the secret

```bash
echo -n "$(openssl rand -hex 32)" | \
  gcloud secrets create cron-secret --data-file=- --project=$PROJECT

# Grant Cloud Run + Scheduler access:
gcloud secrets add-iam-policy-binding cron-secret \
  --member="serviceAccount:$CLOUD_RUN_SA" \
  --role="roles/secretmanager.secretAccessor" --project=$PROJECT
```

### 2. Inject into Cloud Run

In `cloudbuild.yaml` (or your deploy script):

```yaml
- name: gcr.io/google.com/cloudsdktool/cloud-sdk
  args:
    - run
    - deploy
    - promo-guard
    # ...other flags...
    - --set-secrets=CRON_SECRET=cron-secret:latest
```

### 3. Create the Scheduler job

```bash
# Read the secret value once for the Scheduler header.
SECRET=$(gcloud secrets versions access latest --secret=cron-secret --project=$PROJECT)

gcloud scheduler jobs create http promo-guard-retention \
  --location=$REGION \
  --schedule="0 2 * * *" \
  --time-zone="Etc/UTC" \
  --uri="$SERVICE_URL/cron/retention" \
  --http-method=POST \
  --headers="X-Cron-Secret=$SECRET,Content-Type=application/json" \
  --attempt-deadline=300s \
  --project=$PROJECT
```

The endpoint returns immediately after enqueueing — actual deletes happen
in the worker, so the 300s deadline is generous.

### 4. (Optional) Switch to OIDC auth instead of shared secret

Stronger but more work. Cloud Scheduler can sign requests with a service
account; Cloud Run validates the JWT. To switch:

1. Drop `X-Cron-Secret` validation in the route, replace with
   `authenticate.admin` analogue that verifies the OIDC `Authorization`
   header.
2. Create the Scheduler job with `--oidc-service-account-email=...`
   instead of `--headers=X-Cron-Secret=...`.

Skip this until traffic warrants — shared secret + Secret Manager is the
standard pattern for Cloud Scheduler → Cloud Run.

## Local dev

```bash
# .env (already in .env.example):
CRON_SECRET=dev-cron-secret-local-only-not-for-prod

# Trigger the fanout manually:
curl -X POST http://localhost:3000/cron/retention \
  -H "X-Cron-Secret: $CRON_SECRET"

# Then watch the worker logs — one retention_cleanup job per shop.
```

For repeat testing without waiting for the daily cron, you can call the
endpoint from a script, a `make` target, or just curl on demand.

## Failure modes

- **Scheduler down / fails to invoke**: jobs simply don't get enqueued.
  Cloud Scheduler retries automatically (default backoff). If a whole
  day is missed, the next day's cleanup will catch up — deletes are
  idempotent.
- **Endpoint up but DB unreachable**: returns 500, Scheduler retries.
- **Endpoint enqueued but worker down**: `Job` rows accumulate and the
  worker drains them when it comes back up. No data loss.
- **Per-shop handler fails**: standard job retry/dead-letter
  semantics apply — the rest of that day's shops are unaffected.

## Operations

Watch enqueued cron jobs:

```sql
SELECT type, status, count(*)
FROM "Job"
WHERE type LIKE 'retention_%' OR type LIKE 'cron_%'
GROUP BY 1, 2
ORDER BY 1, 2;
```

Ad-hoc retention cleanup for a single shop (skips the cron):

```sql
INSERT INTO "Job" (id, "shopId", type, payload, status, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '<shop-id>', 'retention_cleanup', '{}', 'pending', NOW(), NOW());
```

The worker will pick it up on the next poll.
