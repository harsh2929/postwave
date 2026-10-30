-- 0057_form_file_uploads.sql
--
-- Backing store for the `file_upload` form-field kind. Lead-gen and
-- multi-step survey flows commonly need a resume / brief / asset
-- upload step. We persist a row per uploaded file with an opaque
-- storage_key (S3 in prod, /tmp blob in dev), a mime + size pair we
-- validated at presign time, and a scan_status field so a downstream
-- AV worker can flag infected files before they're delivered to the
-- tenant.
--
-- The submission_id starts NULL — the browser uploads files BEFORE
-- the form is submitted, so the row exists for some seconds before
-- it's linked to a submission. The form-submit handler links the
-- rows by uuid once the submission row is committed. Orphans (rows
-- whose submission_id is still NULL after some retention window)
-- are sweepable by a periodic cleaner.
--
-- Hard cap of 25 MiB per file expressed as a CHECK so bad clients
-- can't smuggle a 5 GiB row past validation.
--
-- RLS: enabled + forced + tenant_isolation, identical to the
-- pattern in 0052_sequence_funnel_events.sql. The presign + link
-- handlers run inside a tenant-scoped tx (or bind app.tenant_id
-- explicitly for the public presign path) so the policy applies.

BEGIN;

CREATE TABLE form_file_uploads (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id         uuid NOT NULL,
    submission_id   uuid,                                   -- NULL until linked at submit time
    storage_key     text NOT NULL UNIQUE,
    mime_type       text NOT NULL,
    size_bytes      bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400), -- 25 MiB
    scan_status     text NOT NULL DEFAULT 'pending'
        CHECK (scan_status IN ('pending','clean','infected','error')),
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    linked_at       timestamptz
);

-- Per-form recent uploads (admin debug view + retention sweeper).
CREATE INDEX form_file_uploads_tenant_form_uploaded_idx
    ON form_file_uploads (tenant_id, form_id, uploaded_at DESC);

-- Lookup by submission for the admin "view submission attachments" path.
-- Partial index: orphaned rows aren't useful for this query.
CREATE INDEX form_file_uploads_tenant_submission_idx
    ON form_file_uploads (tenant_id, submission_id)
    WHERE submission_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON form_file_uploads TO postwave_app;

ALTER TABLE form_file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_file_uploads FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON form_file_uploads
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
