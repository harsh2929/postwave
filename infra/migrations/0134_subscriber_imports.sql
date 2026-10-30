-- 0134_subscriber_imports.sql
--
-- CSV subscriber-import jobs. Two-step flow:
--
--   1. operator uploads CSV → server runs DetectMapping → row
--      lands here with status='preview' + the detected mapping +
--      a sample of rows + a dedupe report (how many rows would
--      collide on the chosen dedupe key).
--   2. operator confirms → status flips to 'queued' → worker
--      picks up + imports.
--
-- Why a dedicated table:
--   * Preview state must survive across page reloads.
--   * Dedupe / dry-run is the "comfort" step every new customer
--     does at least once; making the report durable lets them
--     re-share it with their team before clicking Confirm.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_imports (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    requested_by      uuid,
    requested_by_email text,
    -- The uploaded file lands in object storage; we keep the key
    -- so the worker can stream the bytes back.
    object_key        text NOT NULL,
    original_filename text,
    bytes_total       bigint NOT NULL DEFAULT 0,
    -- Detected column map from packages/migrate/csv.DetectMapping.
    -- Operators can override before confirming; the override
    -- replaces the original mapping in-place.
    mapping           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Sample rows (up to 10) for the preview UI.
    sample_rows       jsonb NOT NULL DEFAULT '[]'::jsonb,
    rows_total        bigint NOT NULL DEFAULT 0,
    -- Dedupe summary computed during preview: counts of existing
    -- vs new subscribers + collisions WITHIN the file itself.
    rows_existing     bigint NOT NULL DEFAULT 0,
    rows_new          bigint NOT NULL DEFAULT 0,
    rows_file_dupes   bigint NOT NULL DEFAULT 0,
    -- "skip" | "update" | "error"  — how to treat collisions.
    on_existing       text NOT NULL DEFAULT 'skip'
                          CHECK (on_existing IN ('skip','update','error')),
    status            text NOT NULL DEFAULT 'preview'
                          CHECK (status IN ('preview','queued','running','ready','failed','cancelled')),
    -- Outcome counters populated by the worker.
    rows_imported     bigint NOT NULL DEFAULT 0,
    rows_skipped      bigint NOT NULL DEFAULT 0,
    rows_failed       bigint NOT NULL DEFAULT 0,
    error             text,
    started_at        timestamptz,
    completed_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriber_imports_queued
    ON subscriber_imports (status, created_at)
    WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_subscriber_imports_tenant
    ON subscriber_imports (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON subscriber_imports TO postwave_app;

ALTER TABLE subscriber_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON subscriber_imports AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
