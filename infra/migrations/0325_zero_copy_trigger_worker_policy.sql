-- 0325_zero_copy_trigger_worker_policy.sql
--
-- Zero-copy trigger workers scan active triggers across tenants, then
-- re-enter tenant scope for each PollOnce call. Migration 0285 created a
-- restrictive tenant_isolation policy, so the worker's ListDue query could
-- not see any rows even after setting app.outbox_worker=true. Keep the
-- normal tenant gate for request paths while allowing the explicit worker GUC.

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON external_warehouse_triggers;
CREATE POLICY tenant_isolation ON external_warehouse_triggers
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
