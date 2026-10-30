# Campaign Assurance operations

This runbook covers the platform-operator support views for Campaign Assurance.
They expose lifecycle and provenance metadata across tenants without exposing a
campaign subject/body, recipient identity, model output, prompt text, provider
payload, mailbox identity, object reference, secret, or free-form error message.

## Access boundary

The routes are mounted beneath `/api/internal/ops` and inherit the existing
distributed rate limit, no-store/nosniff headers, platform-operator session,
fresh TOTP, IP allowlist, and write-CSRF boundary. They do not accept tenant API
keys. The database pool uses `postwave_ops`, which has EXECUTE on three reviewed
functions and no SELECT on the underlying Campaign Assurance tables.

The functions are owned by the isolated
`postwave_campaign_assurance_ops_definer` NOLOGIN/NOSUPERUSER/NOBYPASSRLS role.
That role has exact column-level SELECT grants plus explicit SELECT-only RLS
policies. Do not grant it table-level SELECT, membership, LOGIN, BYPASSRLS,
schema CREATE, default privileges, or mutation privileges.

## Endpoints

- `GET /api/internal/ops/views/campaign-assurance/runs`
  - Optional singular filters: `tenant_id`, `state`, `cursor`, `limit`.
  - `limit` is 1–500. `cursor` is opaque and must be copied unchanged from
    `next_cursor`.
- `GET /api/internal/ops/views/campaign-assurance/runs/{run_id}`
  - Exact run metadata, immutable hashes/versions, capability counts, evidence
    freshness, queue delivery/retry state, cost reservations, and cache counts.
- `GET /api/internal/ops/views/campaign-assurance/runs/{run_id}/timeline`
  - Optional singular `after` event-number cursor and `limit` of 1–500.
  - Returns database-derived event fields. The extensible event `metadata`
    envelope is intentionally excluded.

Unknown, repeated, malformed, or unbounded parameters return 400. Missing runs
return 404. A database read failure returns 500 rather than an empty 200.

## Triage sequence

1. Find the run by tenant and state in the list view. Record `tenant_id`,
   `campaign_id`, and `run_id`; do not request campaign content.
2. Compare `attempt_count`, `max_attempts`, `retry_not_before`, run lease,
   heartbeat, command delivery attempts, and command lease. A stale run lease
   and an active command lease are different failure domains.
3. Use `error_code`, extraction-error counts, and the timeline stage/status to
   select a worker or provider runbook. Never ask a customer to paste provider
   output or credentials into a support ticket.
4. Compare required deterministic/modeled/controlled-observation target counts
   with terminal extraction counts. Controlled observations may legitimately be
   unavailable; do not describe modeled evidence as an observed inbox summary.
5. Check raw-evidence and seed-observation expiry fields before escalating a
   reproducibility issue. Expired evidence is not silently treated as current.
6. Compare actual cost with the modeled-cost ceiling, reservation/settlement
   counts, `charge_unknown_count`, invocation count, and cache-reuse count.
7. Use immutable source/plan/artifact/configuration/target hashes and version
   fields when correlating deployment or methodology drift.

These views are read-only. Retry, cancel, override, and send-gate actions remain
on their existing audited product/operator paths; do not add mutation behavior
to this support surface.

## Verification and incident response

After migration or role changes, run the ops-view package's restricted database
tests with `POSTWAVE_TEST_ADMIN_DATABASE_URL` set. They must prove all three
functions execute under `SET ROLE postwave_ops`, direct source-table reads fail,
the owner is NOLOGIN/NOSUPERUSER/NOBYPASSRLS with a fixed `pg_catalog`
search path, ACLs are EXECUTE-only, RLS policy inventory is exact, and returned
column names remain content-free.

If a content-bearing field appears, disable access at the ops gateway, preserve
audit logs, and treat it as a privacy incident. Do not broaden grants to restore
service. Revert the binary first; then repair the function return type, owner,
ACL, RLS policy, and exact column grants in an additive migration.
