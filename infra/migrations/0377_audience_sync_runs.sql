-- 0377_audience_sync_runs.sql
--
-- Per-run ledger for audience_syncs (0376). One row per "Run now" /
-- scheduler execution. rows_exported counts subscriber rows actually
-- delivered to the destination; error captures the first delivery
-- failure verbatim so the operator can self-diagnose (timeouts, 4xx
-- from their receiver, DNS, …) from the desktop runs drilldown.
--
-- status lifecycle: running -> succeeded | failed. The v1 runner is
-- synchronous-bounded (the HTTP handler executes the run inline with
-- caps on rows + batches + per-batch timeout), so a crash mid-run can
-- orphan a 'running' row; the desktop renders those honestly as
-- "running" with the started_at timestamp.

BEGIN;

CREATE TABLE IF NOT EXISTS audience_sync_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sync_id        uuid NOT NULL REFERENCES audience_syncs(id) ON DELETE CASCADE,
    status         text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','succeeded','failed')),
    rows_exported  integer NOT NULL DEFAULT 0,
    batches_sent   integer NOT NULL DEFAULT 0,
    error          text,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audience_sync_runs_sync_idx
    ON audience_sync_runs (tenant_id, sync_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON audience_sync_runs TO postwave_app;

ALTER TABLE audience_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_sync_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audience_sync_runs
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
