-- 1858_mobile_push_notification_identity.sql
-- rollback-strategy: no-op
-- rollback-details: The nullable column is ignored by older API images and
-- preserves crash-recovery identity for newer workers. Retaining it avoids
-- losing the association between durable delivery evidence and its feed row.
-- deployment-order: migration-first. New API images include notification_id
-- in every delivery INSERT and therefore require the column to exist. The
-- capability-gated policies must also be committed before those images create
-- security rows, so an older worker in the mixed fleet cannot claim one.
--
-- notification_feed.id is the cross-channel identity shared by the bell,
-- native push, web push, and SSE. A mobile delivery claim commits before its
-- Expo request, so every field needed to reproduce that request must live in
-- mobile_push_deliveries. Existing rows intentionally remain NULL: their
-- historical identity cannot be reconstructed safely.
--
-- During a rolling deployment, an older receipt worker can understand the
-- delivery row but not its new notification_id projection. Keep the generic
-- worker policies for routine events, while requiring an explicit compatible
-- worker capability before security deliveries become visible or mutable.

BEGIN;

ALTER TABLE mobile_push_deliveries
    ADD COLUMN IF NOT EXISTS notification_id uuid;

COMMENT ON COLUMN mobile_push_deliveries.notification_id IS
    'Original notification_feed.id carried across native send crash recovery; NULL for legacy deliveries without recoverable identity.';

DROP POLICY IF EXISTS mobile_push_deliveries_worker_select
    ON mobile_push_deliveries;
CREATE POLICY mobile_push_deliveries_worker_select
    ON mobile_push_deliveries
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            event_type <> 'auth.new_device_sign_in'
            OR current_setting('app.mobile_push_notification_identity_worker', true) = 'true'
        )
    );

DROP POLICY IF EXISTS mobile_push_deliveries_worker_update
    ON mobile_push_deliveries;
CREATE POLICY mobile_push_deliveries_worker_update
    ON mobile_push_deliveries
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            event_type <> 'auth.new_device_sign_in'
            OR current_setting('app.mobile_push_notification_identity_worker', true) = 'true'
        )
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            event_type <> 'auth.new_device_sign_in'
            OR current_setting('app.mobile_push_notification_identity_worker', true) = 'true'
        )
    );

COMMIT;
