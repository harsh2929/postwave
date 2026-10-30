-- Restore the least-privilege permissions and RLS paths required by the
-- audit Merkle worker. The partition conversion recreated audit_log after the
-- original worker policy, while the immutability migration correctly revoked
-- broad UPDATE. Without this forward repair the worker either saw no rows or
-- failed every hash backfill with permission denied.

BEGIN;

GRANT UPDATE (prev_hash, row_hash) ON audit_log TO postwave_app;

DROP POLICY IF EXISTS audit_log_merkle_worker_select ON audit_log;
CREATE POLICY audit_log_merkle_worker_select ON audit_log
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.audit_internal_writer', true) = 'true'
    );

DROP POLICY IF EXISTS audit_log_merkle_worker_update ON audit_log;
CREATE POLICY audit_log_merkle_worker_update ON audit_log
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.audit_internal_writer', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.audit_internal_writer', true) = 'true'
    );

COMMIT;
