-- 1900_pii_runtime_contract_tenant_lock.sql
--
-- The PII scanner never scanned anything, for any tenant, silently.
--
-- Enabling scanning fires `tenant_pii_scan_config_coverage_transition`, which
-- binds the tenant to the deployment's active scanner contract:
--
--     SELECT runtime.scan_contract, runtime.availability_status
--       INTO active_scan_contract, runtime_availability
--       FROM public.pii_scan_runtime_contract runtime
--      WHERE runtime.singleton
--      FOR SHARE;
--
-- That runs inside the caller's transaction, and the caller is the API acting
-- for a tenant — `app.tenant_id` set, `app.outbox_worker` not.
--
-- `pii_scan_runtime_contract` had exactly two policies:
--
--     tenant_runtime_visible   FOR SELECT   (app.tenant_id IS NOT NULL)
--     worker_visible           FOR ALL      (app.outbox_worker = 'true')
--
-- PostgreSQL applies UPDATE policies to a row-locking clause, so under tenant
-- scope the row is not LOCKABLE even though it is readable. `FOR SHARE` then
-- returns ZERO ROWS — the plain SELECT returns the row, the FOR SHARE variant
-- does not — and `SELECT ... INTO` over no rows leaves the variables NULL
-- without raising anything.
--
-- So `tenant_pii_scan_coverage.scan_contract` was written NULL. Every claim
-- query requires `coverage.scan_contract = $1`, so no intent was ever claimed,
-- no subscriber was ever scanned, and no finding was ever produced. The config
-- reads back as enabled, coverage sits in `catching_up` forever, and nothing
-- reports an error — the failure looks exactly like a scanner with nothing to
-- do.
--
-- The fix is a policy that permits the LOCK and forbids the WRITE. Only USING
-- is evaluated when a row is locked rather than modified, so
-- `WITH CHECK (false)` lets the trigger pin the contract for the duration of
-- the config transaction — which is the whole point of FOR SHARE — while making
-- any actual UPDATE by a tenant impossible.
--
-- Deliberately NOT fixed by dropping `FOR SHARE` from the trigger: the lock is
-- load-bearing. Without it the deployment contract could change between the
-- read and the coverage write, binding a tenant to a contract that is no longer
-- active. And deliberately NOT fixed by widening the tenant policy to FOR ALL,
-- which would let any tenant rewrite a deployment-wide singleton.

BEGIN;

DROP POLICY IF EXISTS tenant_runtime_lockable ON pii_scan_runtime_contract;
CREATE POLICY tenant_runtime_lockable ON pii_scan_runtime_contract
    FOR UPDATE
    USING (NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL)
    WITH CHECK (false);

COMMENT ON POLICY tenant_runtime_lockable ON pii_scan_runtime_contract IS
    'Permits SELECT ... FOR SHARE from a tenant transaction so the coverage '
    'trigger can pin the active scanner contract. WITH CHECK (false) means no '
    'tenant can actually modify the deployment singleton. Without this the '
    'trigger''s FOR SHARE matched zero rows and every tenant was bound to a '
    'NULL contract, which no claim query can match.';

COMMIT;
