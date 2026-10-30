-- 1872_consent_sync_worker_discovery.sql
--
-- Let the consent-sync sweeper FIND the tenants that have work, without
-- weakening the ledger's tenant isolation by one row.
--
-- `ConsentSyncLedger.RunRetrySweep` shipped complete and had no caller, so a
-- consent push that failed its first delivery was never retried: the row sat in
-- `retrying` with a `next_attempt_at` no worker ever read, and the destination
-- kept a record the subscriber had asked to have dropped. The sweeper that
-- fixes that has to answer one question across tenants — "who has a due row?" —
-- and a worker holds no tenant context, so RLS correctly hides everything.
--
-- WHY NOT THE HOUSE `app.outbox_worker` BYPASS. That idiom (migration 1804,
-- `scheduled_report_runs_worker`) adds a PERMISSIVE policy. It cannot work
-- here: `consent_sync_ledger`'s `tenant_isolation` policy is RESTRICTIVE, so it
-- ANDs with every other policy and no permissive addition can widen past
-- `tenant_id = current_setting('app.tenant_id')`. That restriction is the right
-- design for a consent ledger and is not worth trading for a worker's
-- convenience.
--
-- So the crossing-point is a SECURITY DEFINER function instead, which is
-- narrower than a policy in the way that matters: a policy would expose whole
-- ROWS to any query the worker chose to write, whereas this exposes exactly one
-- projection — the set of tenant ids with due work — and nothing else. No
-- subscriber id, no destination URL, no event type, and no write path. Each
-- tenant's rows are then read and updated inside `db.WithTenant`, under the
-- ordinary restrictive policy, exactly as the ledger writer does.

BEGIN;

-- Undo the permissive policy this migration first attempted. It was inert
-- (restrictive tenant_isolation ANDs it away) but leaving a policy that reads
-- as a bypass and is not one is worse than not having it.
DROP POLICY IF EXISTS consent_sync_ledger_worker_discovery ON consent_sync_ledger;

CREATE OR REPLACE FUNCTION consent_sync_due_tenants()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT tenant_id
      FROM consent_sync_ledger
     WHERE status IN ('pending', 'retrying')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
$$;

COMMENT ON FUNCTION consent_sync_due_tenants() IS
    'Tenant ids with at least one consent-sync row due for delivery. SECURITY '
    'DEFINER because consent_sync_ledger''s tenant_isolation policy is '
    'RESTRICTIVE, so a worker with no tenant context sees nothing and no '
    'permissive policy can widen it. Returns ONLY tenant ids: the sweeper then '
    'reads and updates each tenant''s rows inside db.WithTenant under the '
    'ordinary policy.';

REVOKE ALL ON FUNCTION consent_sync_due_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consent_sync_due_tenants() TO postwave_app;

COMMENT ON TABLE consent_sync_ledger IS
    'Consent changes owed to connected destinations. Written when a subscriber '
    'unsubscribes or revokes consent; drained by ConsentSyncSweeper, which '
    'discovers due tenants via consent_sync_due_tenants() and then delivers '
    'inside each tenant''s own RLS context.';

COMMIT;
