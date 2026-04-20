# Incident Response Policy

This policy covers how Promo Guard responds to security incidents affecting
merchant or customer data. It satisfies Shopify's Protected Customer Data
requirement for a written incident response procedure.

## Scope

An "incident" is any unauthorized access to, disclosure of, or loss of:

- Shopify merchant or customer data held in Promo Guard's database
- Application secrets (KEK, DEK, database credentials, Shopify API keys)
- Merchant session tokens or API access
- Any hashed or encrypted identity data that could be linked back to
  individuals through combination with external data

## Roles

- **Incident owner**: Khoi Nguyen (founder / sole maintainer)
- **Contact**: security@scentiment.com
- **Escalation**: Shopify Partner support + affected merchants

## Severity tiers

- **P0 — Active breach**: attacker has confirmed access to plaintext PII,
  secrets, or production database. Triage within 1 hour.
- **P1 — Credential or key exposure**: secret leaked to logs, public repo,
  or third-party service; no confirmed misuse. Triage within 4 hours.
- **P2 — Anomalous access**: unusual auth failures, unexpected API usage,
  unrecognized login. Triage within 24 hours.

## Response timeline

| Step | Deadline | Action |
|---|---|---|
| 1. Triage | Per severity above | Confirm the incident; classify P0/P1/P2 |
| 2. Contain | +1 hour from confirmation | Revoke credentials, rotate salts/KEK, invalidate sessions, disable affected endpoints |
| 3. Assess | +8 hours | Identify scope of data affected, list of merchants impacted |
| 4. Notify merchants | +72 hours from confirmation (per GDPR Art. 33) | Email affected merchants with scope, containment actions, and next steps |
| 5. Notify Shopify | +72 hours | Open a Partner support ticket for any incident involving merchant data |
| 6. Regulatory notification | Per local law | GDPR 72-hour rule where applicable |
| 7. Post-mortem | +14 days from resolution | Written root cause analysis, action items, policy updates |

## Containment actions (P0 playbook)

1. **Rotate per-shop salt** on every affected shop via the `rotate_salt` job,
   which triggers re-hash of all RedemptionRecord rows and rebuild of shop-wide
   shard metafields.
2. **Rotate KEK** in GCP Secret Manager; re-wrap all DEKs via the key rotation
   procedure.
3. **Revoke database credentials** and issue fresh ones from Neon; update the
   runtime `DATABASE_URL` secret.
4. **Revoke Shopify API credentials** via Partner Dashboard; merchants
   re-authorize on next app load.
5. **Invalidate all sessions**: truncate the `Session` table; all merchants
   re-authenticate on next admin visit.
6. **Freeze webhook processing** if the incident involves the worker itself,
   by scaling the worker to zero and failing all pending jobs.

## Logging and audit

- Admin impersonation reads are logged in `AdminAuditLog` (see
  `app/lib/admin-audit.server.ts`).
- Neon retains Postgres query logs per its platform policy.
- GCP retains Secret Manager access logs for the KEK.

## Periodic review

Reviewed at least annually, or immediately after any P0/P1 incident.

---

Last reviewed: 2026-04-20
