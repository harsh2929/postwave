-- 1857_device_signin_alert_outbox_idempotency.sql
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Keep both the partial unique index and capability-gated
-- worker policies on application rollback. Older workers continue draining
-- every historical kind but cannot claim the new kind they cannot dispatch;
-- its rows remain pending until a compatible worker returns.
--
-- Cross-device session confirmation writes auth.new_device_sign_in.dispatch
-- into the shared transactional outbox. Confirmation's row locks already make
-- the first write singular; this index is a database-level last line of
-- defence against a future replay path enqueueing the same session twice.
-- A generic outbox worker sends unknown kinds straight to its DLQ. During a
-- rolling deploy an older replica must therefore be unable to see this kind.
-- Compatible workers set both app.outbox_worker and the new transaction-local
-- app.device_signin_outbox_worker capability; old workers set only the former.
-- Tenant-scoped append/read paths remain admitted by tenant_isolation.
-- DEPLOYMENT ORDER IS MIGRATION FIRST: install this visibility fence before
-- any binary is allowed to enqueue the new kind.

BEGIN;

DROP POLICY IF EXISTS outbox_worker_select ON outbox_events;
CREATE POLICY outbox_worker_select ON outbox_events
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            kind <> 'auth.new_device_sign_in.dispatch'
            OR current_setting('app.device_signin_outbox_worker', true) = 'true'
        )
    );

DROP POLICY IF EXISTS outbox_worker_update ON outbox_events;
CREATE POLICY outbox_worker_update ON outbox_events
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            kind <> 'auth.new_device_sign_in.dispatch'
            OR current_setting('app.device_signin_outbox_worker', true) = 'true'
        )
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            kind <> 'auth.new_device_sign_in.dispatch'
            OR current_setting('app.device_signin_outbox_worker', true) = 'true'
        )
    );

COMMIT;

-- Build the idempotency fence online so deploying the security alert does not
-- block the shared outbox table used by unrelated integrations. A concurrent
-- build interrupted by a crash can leave an INVALID index with the intended
-- name; IF NOT EXISTS would silently bless that unusable shell. Drop/rebuild
-- on every execution so both normal reruns and interruption recovery converge
-- to one valid, ready index.

DROP INDEX CONCURRENTLY IF EXISTS outbox_device_signin_session_unique_idx;

CREATE UNIQUE INDEX CONCURRENTLY outbox_device_signin_session_unique_idx
    ON outbox_events (tenant_id, ((payload ->> 'session_id')))
    WHERE kind = 'auth.new_device_sign_in.dispatch'
      AND COALESCE(payload ->> 'session_id', '') <> '';
