-- 1731_mobile_push_receipt_reconciliation.sql
--
-- An Expo send response is only a ticket: status=ok means Expo accepted the
-- message, not that APNs/FCM delivered it. Persist the exact server-authored
-- copy needed for crash recovery, add bounded receipt-attempt state, and give
-- the transaction-local worker scope only the SELECT/UPDATE access needed to
-- lease work across tenants. Terminal DeviceNotRegistered reconciliation
-- keeps the device row as revocation evidence while erasing its recoverable
-- token envelope.
--
-- rollback-strategy: no-op - older API images ignore the additive columns;
-- retaining terminal delivery evidence and revoked token erasure is safer
-- than attempting to reconstruct provider credentials.

BEGIN;

ALTER TABLE mobile_push_devices
    ALTER COLUMN token_envelope DROP NOT NULL;

UPDATE mobile_push_devices
   SET token_envelope = NULL,
       enabled_events = '{}'
 WHERE status = 'revoked';

ALTER TABLE mobile_push_devices
    ADD CONSTRAINT mobile_push_devices_active_token_envelope_check
    CHECK (status <> 'active' OR token_envelope IS NOT NULL);

ALTER TABLE mobile_push_deliveries
    ADD COLUMN title text NOT NULL DEFAULT 'Postwave update',
    ADD COLUMN body text NOT NULL DEFAULT 'Open Postwave for details.',
    ADD COLUMN category_id text NOT NULL DEFAULT 'entity',
    ADD COLUMN receipt_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN delivered_at timestamptz,
    ADD COLUMN terminal_at timestamptz;

UPDATE mobile_push_deliveries
   SET category_id = 'approval'
 WHERE event_type = 'approval.requested';

-- Recover rows abandoned after a process stopped between its durable claim
-- and the network/finalisation phase. Accepted tickets wait Expo's recommended
-- observation window before their first receipt request.
UPDATE mobile_push_deliveries
   SET next_retry_at = CASE
       WHEN status = 'accepted' THEN now() + interval '15 minutes'
       WHEN status = 'queued' THEN now()
       ELSE next_retry_at
   END
 WHERE status IN ('accepted', 'queued')
   AND next_retry_at IS NULL;

ALTER TABLE mobile_push_deliveries
    DROP CONSTRAINT mobile_push_deliveries_status_check,
    ADD CONSTRAINT mobile_push_deliveries_status_check
        CHECK (status IN ('queued', 'accepted', 'delivered', 'failed', 'revoked')),
    ADD CONSTRAINT mobile_push_deliveries_title_check
        CHECK (octet_length(title) BETWEEN 1 AND 120),
    ADD CONSTRAINT mobile_push_deliveries_body_check
        CHECK (octet_length(body) BETWEEN 1 AND 240),
    ADD CONSTRAINT mobile_push_deliveries_category_check
        CHECK (category_id IN ('approval', 'entity')),
    ADD CONSTRAINT mobile_push_deliveries_receipt_attempts_check
        CHECK (receipt_attempts BETWEEN 0 AND 8),
    ADD CONSTRAINT mobile_push_deliveries_delivered_at_check
        CHECK (status <> 'delivered' OR delivered_at IS NOT NULL);

CREATE POLICY mobile_push_deliveries_worker_select
    ON mobile_push_deliveries
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY mobile_push_deliveries_worker_update
    ON mobile_push_deliveries
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMENT ON COLUMN mobile_push_deliveries.expo_ticket_id IS
    'Expo acceptance ticket. Presence does not prove delivery; the receipt worker must persist delivered/failed/revoked.';
COMMENT ON COLUMN mobile_push_deliveries.receipt_attempts IS
    'Bounded number of leased Expo receipt checks; terminalised after eight attempts.';
COMMENT ON COLUMN mobile_push_deliveries.next_retry_at IS
    'Next eligible send retry or accepted-ticket receipt check; NULL for terminal rows.';
COMMENT ON COLUMN mobile_push_deliveries.terminal_at IS
    'When a delivery reached delivered, terminal failed, or revoked state.';

COMMIT;

-- The worker enumerates due work across tenants. The earlier tenant-leading
-- index cannot support that global status/time scan, so keep a small partial
-- queue index. CONCURRENTLY avoids blocking live registration/delivery writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mobile_push_deliveries_worker_due_idx
    ON mobile_push_deliveries (status, next_retry_at, created_at)
    WHERE status IN ('queued', 'accepted', 'failed')
      AND next_retry_at IS NOT NULL;
