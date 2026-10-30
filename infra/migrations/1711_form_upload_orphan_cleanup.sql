-- Reclaim file objects uploaded for public forms but never linked to a
-- completed submission. cleanup_claimed_at is a short worker lease: object
-- deletion happens outside the database transaction and can be retried
-- safely because every supported object store implements idempotent Delete.

BEGIN;

ALTER TABLE form_file_uploads
    ADD COLUMN cleanup_claimed_at timestamptz;

GRANT DELETE ON form_file_uploads TO postwave_app;

-- The sweeper must discover and claim abandoned rows across tenants. Keep
-- each policy limited to unlinked rows so worker scope cannot expose linked
-- customer uploads through this path.
CREATE POLICY form_file_uploads_orphan_worker_select
    ON form_file_uploads
    FOR SELECT
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND submission_id IS NULL
    );

CREATE POLICY form_file_uploads_orphan_worker_update
    ON form_file_uploads
    FOR UPDATE
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND submission_id IS NULL
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND submission_id IS NULL
    );

CREATE POLICY form_file_uploads_orphan_worker_delete
    ON form_file_uploads
    FOR DELETE
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND submission_id IS NULL
    );

COMMIT;

-- The orphan-scan index is created concurrently by migration 1716. Keeping
-- the index build out of this transaction avoids blocking writes to the
-- existing upload table while preserving an atomic schema/policy change.
