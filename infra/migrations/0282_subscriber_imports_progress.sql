-- 0282_subscriber_imports_progress.sql
--
-- SUB-102-103: turns CSV subscriber imports into real background jobs.
--
-- Extends the existing subscriber_imports table (0134) with progress +
-- cancellation columns the worker writes back every chunk, plus a
-- companion subscriber_import_errors table so failing rows are kept
-- around for retry/inspection instead of disappearing into a counter.

BEGIN;

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS processed_rows   bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chunk_size       int    NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS last_chunk_at    timestamptz,
    ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;

-- The desktop wizard exposes "replace" as a third strategy; treat it
-- identically to "update" server-side (idempotent CHECK swap).
ALTER TABLE subscriber_imports DROP CONSTRAINT IF EXISTS subscriber_imports_on_existing_check;
ALTER TABLE subscriber_imports
    ADD CONSTRAINT subscriber_imports_on_existing_check
    CHECK (on_existing IN ('skip','update','replace','error'));

CREATE TABLE IF NOT EXISTS subscriber_import_errors (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    import_id   uuid NOT NULL REFERENCES subscriber_imports(id) ON DELETE CASCADE,
    row_number  bigint NOT NULL,
    email       text,
    error       text NOT NULL,
    raw_row     jsonb,
    retried     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_import_errors_import
    ON subscriber_import_errors (import_id, retried);
CREATE INDEX IF NOT EXISTS idx_sub_import_errors_tenant
    ON subscriber_import_errors (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_import_errors TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE subscriber_import_errors_id_seq TO postwave_app;

ALTER TABLE subscriber_import_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON subscriber_import_errors AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
