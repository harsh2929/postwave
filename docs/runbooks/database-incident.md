# Runbook — Database (Postgres) Incident

Generic Postgres recovery + Moosewave-specific row-level-security (RLS)
verification. Moosewave's multi-tenancy is enforced at the database via
RLS policies on every tenant-scoped table — a bypass is a SEV0 event.

Three classes of database incident, each with its own playbook:
1. **Outage** — Postgres unavailable.
2. **Runaway query** — single query consuming all CPU/IO.
3. **RLS bypass detected** — a tenant saw or wrote another tenant's data.

---

## Class A — Postgres outage

### Symptoms
- Services 5xx with `pq: connection refused` / `dial tcp ... no route to host`.
- Neon (or RDS) status page shows the cluster down.
- `pg_stat_database` not collected for ≥1 min.

### Severity
SEV1 always. Most user-facing actions need Postgres.

### Immediate response
1. Confirm via the managed-DB provider's status page (Neon, RDS).
2. Switch services to **read-only / degraded mode** via the global
   feature flag:
   ```bash
   curl -X POST $POSTWAVE_API_URL/internal/flags/db_read_only \
     -H "Authorization: Bearer $POSTWAVE_INTERNAL_TOKEN" \
     -d '{"value": true}'
   ```
   In degraded mode:
   - UI shows a "Some features are temporarily unavailable" banner.
   - Sequence triggers buffer to a Redis SET (drained on recovery).
   - Listmonk send queue continues (Listmonk has its own DB connection;
     if same DB, this won't help — see Class A specific scenario below).
3. Page DBA + on-call.

### Investigation
- Neon: is this a branch/replica problem (failover lag) or a primary
  outage? Branch problems are usually 1-5min; primary outages are
  longer.
- RDS: `aws rds describe-events --duration 60` for the last hour.
- If self-hosted: `journalctl -u postgresql -n 200`.

### Recovery
- Wait for managed provider, OR fail over to standby (if configured).
- After the cluster is back, **drain the Redis trigger buffer** with the
  `automation-trigger-replay` job: `kubectl create job --from=cronjob/automation-trigger-replay manual-$(date +%s)`.
- Turn off `db_read_only`.
- Verify `automation_enrollments_pending` returns to baseline.

---

## Class B — Runaway query

### Symptoms
- Single Postgres connection at 100% CPU.
- Other queries blocking or slow.
- `pg_stat_activity` shows one row with `state = 'active'` and a
  long `query_start`.

### Detection
Continuous query in our monitoring:

```sql
SELECT pid, usename, application_name, state,
       NOW() - query_start AS runtime, query
FROM pg_stat_activity
WHERE state = 'active' AND NOW() - query_start > INTERVAL '30 seconds'
ORDER BY runtime DESC;
```

### Severity
- Single query <2 min → SEV3 (kill, file ticket on the originating service)
- Multiple queries blocked by lock → SEV2
- DB connections at pool ceiling, errors propagating → SEV1

### Immediate response
1. Capture the query and `pg_locks` state (so we can reproduce):
   ```sql
   COPY (
     SELECT * FROM pg_stat_activity
     WHERE state = 'active'
   ) TO '/tmp/runaway-$(date +%s).csv' CSV HEADER;

   SELECT * FROM pg_locks WHERE granted = false;
   ```
2. **Kill the query** (not the connection):
   ```sql
   SELECT pg_cancel_backend(<pid>);
   ```
   If `cancel` doesn't work in 30s:
   ```sql
   SELECT pg_terminate_backend(<pid>);
   ```
3. If lock storm — kill in dependency order (oldest blocker first).

### Investigation
- Match query to source service via `application_name` (we set this per
  service in `pgx` connection options).
- File a ticket: which endpoint generated this? Add an index? Add
  `LIMIT`? Move to a read replica?

---

## Class C — RLS bypass detected

**This is SEV0. Wake everyone up.** Multi-tenant data leak.

### Symptoms
- An audit log shows a user reading or writing rows belonging to a tenant
  they're not associated with.
- A bug report from a customer describing seeing another customer's data.
- Our weekly RLS-coverage test (CI) failed.

### Detection
1. **CI gate**: `services/migration/test/rls_test.go` (and equivalents)
   logs in as tenant A and asserts SELECT/UPDATE/DELETE on tenant B's
   rows return empty / are denied.
2. **Runtime check**: every API response carries
   `X-Postwave-Tenant-Boundary` set to a hash of the tenant context;
   our gateway logs warn if the response payload contains a different
   tenant_id (we redact in JSON, so this should never happen).

### Immediate response (P0)
1. **Lock down**: rotate the involved service-account token, force
   re-login on all sessions for affected tenants, and switch the
   service to read-only.
2. **Open a SEV0 incident channel.** Loop in legal + security
   immediately — depending on jurisdiction this may be a notifiable
   data breach.
3. **Capture forensics before changing anything else:**
   ```sql
   -- Grab full audit log for affected tenants for the suspected window.
   COPY (
     SELECT * FROM audit_log
     WHERE tenant_id IN ($A, $B) AND created_at > $T
   ) TO '/tmp/forensic-$(date +%s).csv' CSV HEADER;
   ```
4. **Verify RLS policies are still in place:**
   ```sql
   SELECT schemaname, tablename, rowsecurity FROM pg_tables
   WHERE schemaname = 'public' AND tablename IN (
     'subscribers', 'campaigns', 'lists', 'audit_log',
     'migrations', 'automation_enrollments', 'voice_profiles',
     'sequences', 'templates'
   );
   -- All `rowsecurity` must be true.

   SELECT polname, polrelid::regclass, polcmd, polqual::text
   FROM pg_policy
   WHERE polrelid::regclass::text IN (
     'subscribers','campaigns','lists','audit_log','migrations',
     'automation_enrollments','voice_profiles','sequences','templates'
   );
   ```
5. **Verify the tenant-context middleware is setting the GUC**:
   ```sql
   -- Per-connection, called on every request via SET LOCAL.
   SHOW postwave.tenant_id;
   ```
   If empty, RLS falls open or closed depending on policy — we use
   "deny by default" (`USING (tenant_id = current_setting('postwave.tenant_id')::uuid)`).

### Root-cause buckets
- **Code path that opens a connection without the middleware** — usually
  background jobs or admin scripts. Audit `services/*/internal/db` for
  raw `sqlx.Connect` outside the wrapped `db.WithTenant(ctx, tenantID)`.
- **Policy gap** on a recently added table.
- **Superuser query** ran via `psql` on prod. (Why does this engineer
  have superuser?)

### Resolution
1. Patch (close the connection path / add policy).
2. Re-run the RLS test suite locally before merging.
3. Add a regression test for the exact scenario.
4. Notify customers per the Communication template below.

---

## Moosewave-specific RLS verification commands

Quick health check (run any time, on any environment):

```sql
-- 1. RLS is on for every tenant-scoped table.
DO $$
DECLARE
  t TEXT;
  bad TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR t IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public'
             AND tablename IN ('subscribers','campaigns','lists','audit_log',
                               'migrations','automation_enrollments','voice_profiles',
                               'sequences','templates','seedlist_inboxes')
  LOOP
    IF NOT (SELECT rowsecurity FROM pg_tables
            WHERE schemaname='public' AND tablename=t) THEN
      bad := array_append(bad, t);
    END IF;
  END LOOP;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'RLS missing on: %', bad;
  END IF;
END $$;

-- 2. Cross-tenant select returns zero (run as a non-superuser test role).
SET LOCAL postwave.tenant_id = '00000000-0000-0000-0000-000000000001';
SELECT count(*) FROM subscribers WHERE tenant_id <> '00000000-0000-0000-0000-000000000001';
-- expect 0
```

---

## Post-mortem template

```
## Database incident — <class> — <ts>
**Detected:** <ts>      **Resolved:** <ts>      **Severity:** SEV<N>

### Class
<outage | runaway query | RLS bypass>

### Customer impact
- Read leakage: yes/no, rows count
- Write leakage: yes/no, rows count
- Downtime: <duration>

### Root cause

### Containment
- <steps taken>

### Followups
- [ ] Patch
- [ ] Regression test
- [ ] (RLS-only) post-incident notification per GDPR/CCPA where applicable
- [ ] (Class A) DB pool size review
- [ ] (Class B) index/optimizer hint added
```

## Communication templates

(Class A, customer-facing):

> Moosewave was unavailable from <start> to <end> UTC due to a database
> incident with our managed provider. All your data is intact. Send
> queues drained automatically once we recovered. We're filing the
> incident with our provider for service credits.

(Class C, customer-facing — DRAFT, hand to legal before sending):

> Subject: Important: Moosewave security incident notification
>
> [Specific facts only. Do not speculate. Include: data category accessed,
> time window, tenants affected, mitigation taken, what the customer
> should do, contact for questions.]
