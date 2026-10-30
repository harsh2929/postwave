-- Public-form uploads are never trusted at presign or submission time. This
-- migration turns the legacy, dormant scan_status column into a worker-owned
-- quarantine state machine with bounded retry leases.

BEGIN;

ALTER TABLE form_file_uploads
    DROP CONSTRAINT IF EXISTS form_file_uploads_scan_status_check;

ALTER TABLE form_file_uploads
    ALTER COLUMN scan_status SET DEFAULT 'quarantined',
    ADD CONSTRAINT form_file_uploads_scan_status_check
        CHECK (scan_status IN ('pending','quarantined','clean','infected','rejected','error')),
    ADD COLUMN scan_attempts integer NOT NULL DEFAULT 0 CHECK (scan_attempts >= 0),
    ADD COLUMN scan_claimed_at timestamptz,
    ADD COLUMN scan_next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN scanned_at timestamptz,
    ADD COLUMN scan_detail text CHECK (scan_detail IS NULL OR length(scan_detail) <= 512),
    ADD COLUMN object_deleted_at timestamptz;

UPDATE form_file_uploads
   SET scan_status = 'quarantined'
 WHERE scan_status = 'pending';

-- The scanner enumerates all tenants, but only quarantined rows. The generic
-- worker flag is set transaction-locally by db.WithWorkerScope; it grants no
-- visibility into clean customer attachments.
CREATE POLICY form_file_uploads_scanner_select
    ON form_file_uploads
    FOR SELECT
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            (submission_id IS NOT NULL AND scan_status IN ('pending','quarantined'))
            OR (scan_status IN ('infected','rejected','error') AND object_deleted_at IS NULL)
        )
    );

CREATE POLICY form_file_uploads_scanner_update
    ON form_file_uploads
    FOR UPDATE
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            (submission_id IS NOT NULL AND scan_status IN ('pending','quarantined'))
            OR (scan_status IN ('infected','rejected','error') AND object_deleted_at IS NULL)
        )
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND submission_id IS NOT NULL
        AND scan_status IN ('pending','quarantined','clean','infected','rejected','error')
    );

COMMIT;

-- The scan/cleanup indexes are created concurrently by migration 1716. This
-- transaction remains limited to the atomic state-machine and policy change.
