-- 0132_tenant_exports.sql
--
-- GDPR Article 20 / SOC 2 data portability — async tenant data
-- export jobs.
--
-- Flow:
--   1. Operator POSTs to /api/v1/exports with { include: [...] }.
--      The server creates a row here with status='queued'.
--   2. The export worker picks up queued rows, walks each requested
--      table (subscribers, campaigns, audit_log, etc.) under the
--      tenant's RLS GUC, writes JSONL/CSV files into a temp bundle,
--      uploads the bundle to object storage, and stores a SIGNED
--      URL on download_url. Status flips to 'ready'.
--   3. Operator GETs /api/v1/exports/{id} → polls until ready, then
--      downloads from download_url before expires_at.
--
-- Retention: rows live forever (1 row per export is small); the
-- bundle in object storage expires per the bucket's lifecycle
-- policy (default 7 days). Operators can re-request an export at
-- any time.
--
-- expires_at is the signed URL's expiry, NOT the row's. The
-- distinction matters: an auditor asking "did Acme ever export
-- their data?" should still find the historical row even after
-- the download URL is dead.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_exports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    -- Operator (user) who requested the export. Stored as the
    -- users.id rather than email because the email may rotate.
    requested_by    uuid,
    requested_by_email text,  -- denormalized for audit-trail readability
    -- include is a JSONB array of canonical resource names; the
    -- worker iterates each + writes a file per entry.
    -- e.g. ["subscribers", "campaigns", "automations", "audit_log"]
    include         jsonb NOT NULL DEFAULT '[]'::jsonb,
    status          text  NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','ready','failed','expired')),
    -- Bundle metadata. Populated by the worker when status flips to
    -- 'ready'. The signed URL lives in download_url; the bytes are
    -- in object storage.
    object_key      text,                   -- e.g. exports/<tenant>/<id>.zip
    bytes_total     bigint NOT NULL DEFAULT 0,
    rows_total      bigint NOT NULL DEFAULT 0,
    download_url    text,
    expires_at      timestamptz,            -- signed URL expiry
    error           text,                   -- when status='failed'
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_exports_status
    ON tenant_exports (status, created_at)
    WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_tenant_exports_tenant
    ON tenant_exports (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON tenant_exports TO postwave_app;

ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON tenant_exports AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
