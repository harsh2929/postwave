-- 0307_audit_export_jobs.sql
--
-- sse-pinned-tail (Audit, UX, P1)
--
-- Async CSV export job tracking. The audit page used to issue a
-- synchronous /audit/export request that streamed up to 100k rows in
-- one HTTP response. Auditors with year-spanning filters routinely hit
-- proxy timeouts. This table backs the new "queue an async export,
-- poll for progress, email me when ready" flow.
--
-- Workers poll on (status='pending') and transition the row through
-- 'in_progress' -> 'completed' or 'failed'. Completed jobs are garbage
-- collected by the existing janitor after 30 days.
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair using the
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom
-- (raw ::uuid cast crashes when the GUC is unset).

BEGIN;

CREATE TABLE IF NOT EXISTS audit_export_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Nullable for system-initiated exports (none today). For
    -- operator-issued exports we record the user_id so the audit page
    -- can show "your last export" alongside the tenant-wide list.
    requested_by      UUID,
    requested_by_email TEXT,
    -- Opaque filter set as understood by the audit handler. Stored as
    -- jsonb so adding a new filter axis later doesn't require a
    -- schema change.
    filters_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','in_progress','completed','failed')),
    -- EXPLAIN-bounded row-count estimate populated at enqueue time so
    -- the UI can show "exporting ~24,000 rows" before the first batch
    -- streams. May diverge slightly from the final exported_rows.
    estimated_rows    BIGINT,
    -- Live progress bumped by the worker after each batch flush.
    exported_rows     BIGINT NOT NULL DEFAULT 0,
    total_bytes       BIGINT NOT NULL DEFAULT 0,
    -- Local file path / S3 URL once status='completed'. Nullable
    -- until completion; null + status='completed' is a worker bug.
    file_url          TEXT,
    -- Last error message when status='failed'. UI surfaces it inline.
    error_reason      TEXT,
    email_on_complete BOOLEAN NOT NULL DEFAULT false,
    email_address     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_export_jobs_tenant_status
    ON audit_export_jobs (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_export_jobs_pending
    ON audit_export_jobs (created_at)
    WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_export_jobs TO postwave_app;

ALTER TABLE audit_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_export_jobs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_export_jobs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON audit_export_jobs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
