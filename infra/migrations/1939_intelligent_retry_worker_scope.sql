-- 1939_intelligent_retry_worker_scope.sql
--
-- The intelligent-retry worker claims due events before it knows their
-- tenant. Migration 0326 put the worker predicate only in a RESTRICTIVE
-- policy. PostgreSQL still requires at least one PERMISSIVE policy to admit a
-- row, so postwave_app could not see any due event even while
-- app.outbox_worker was transaction-locally enabled. Add the narrow worker
-- policies needed for that claim/update window. The generic outbox capability
-- is intentionally insufficient: this queue also requires the dedicated
-- transaction-local app.intelligent_retry_worker capability. Promotion itself
-- immediately re-enters the event's tenant scope before reading the campaign
-- or inserting a recipient.
--
-- rollback-strategy: no-op. Removing these policies would silently stop the
-- durable retry queue while leaving pending events behind.

BEGIN;

DROP POLICY IF EXISTS intelligent_retry_worker_select
    ON intelligent_retry_events;
CREATE POLICY intelligent_retry_worker_select ON intelligent_retry_events
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.intelligent_retry_worker', true) = 'true'
    );

DROP POLICY IF EXISTS intelligent_retry_worker_update
    ON intelligent_retry_events;
CREATE POLICY intelligent_retry_worker_update ON intelligent_retry_events
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.intelligent_retry_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.intelligent_retry_worker', true) = 'true'
    );

COMMIT;
