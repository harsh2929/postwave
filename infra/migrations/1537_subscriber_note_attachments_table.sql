-- 1537_subscriber_note_attachments_table.sql
--
-- SUB-097: file attachments on subscriber notes.
--
-- A note (subscriber_notes, 0148) can carry one or more uploaded files —
-- a screenshot of a support ticket, a signed contract PDF, a CSV the
-- operator wants pinned next to the profile. The bytes live in the
-- tenant-scoped object store (uploads.Store, keyed under
-- tenants/{tenant}/...); this junction table stores only the metadata +
-- the storage key so the notes API can list attachments, hand out
-- presigned-GET download links, and delete both the row and the object.
--
-- One row per attached file. file_key is the tenant-relative object-store
-- key (what uploads.Store.Get / PresignGet / Delete take as `rest`).
--
-- Tenant-scoped + RLS, copied from the canonical shape used by
-- 0148_subscriber_notes.sql / 0303_subscriber_signup_source.sql: every
-- policy reads the tenant via NULLIF(current_setting('app.tenant_id',
-- true), '')::uuid so an unset GUC yields NULL (no rows) instead of
-- crashing on a raw ::uuid cast.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_note_attachments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    note_id             uuid NOT NULL REFERENCES subscriber_notes(id) ON DELETE CASCADE,
    subscriber_id       uuid NOT NULL,
    file_key            text NOT NULL CHECK (length(file_key) BETWEEN 1 AND 1024),
    filename            text NOT NULL CHECK (length(filename) BETWEEN 1 AND 512),
    content_type        text NOT NULL DEFAULT 'application/octet-stream',
    size_bytes          bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    uploaded_by_user_id uuid,
    uploaded_by_email   citext,
    uploaded_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, note_id, file_key)
);

CREATE INDEX IF NOT EXISTS idx_subscriber_note_attachments_note
    ON subscriber_note_attachments (tenant_id, note_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriber_note_attachments_sub
    ON subscriber_note_attachments (tenant_id, subscriber_id, uploaded_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_note_attachments TO postwave_app;

ALTER TABLE subscriber_note_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriber_note_attachments AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
