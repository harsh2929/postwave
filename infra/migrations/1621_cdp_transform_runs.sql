-- 1621_cdp_transform_runs.sql
--
-- Audit ledger for bulk profile-transform runs. The cdp_transforms engine
-- (apps/api/internal/cdp_transforms) could only PREVIEW transforms against an
-- ad-hoc property map; it had no way to APPLY a transform across real
-- subscribers. The new apply endpoint mutates subscribers.custom_fields in bulk
-- and records one row here per run (including dry-runs) so every bulk profile
-- change is auditable: which ops, how many subscribers touched/changed/failed,
-- and whether it was a dry run.

BEGIN;

CREATE TABLE IF NOT EXISTS cdp_transform_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ops            jsonb NOT NULL,
    subscriber_ids uuid[] NOT NULL DEFAULT '{}',
    total          integer NOT NULL DEFAULT 0 CHECK (total >= 0),
    changed        integer NOT NULL DEFAULT 0 CHECK (changed >= 0),
    failed         integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
    dry_run        boolean NOT NULL DEFAULT false,
    created_by     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cdp_transform_runs_tenant_idx
    ON cdp_transform_runs (tenant_id, created_at DESC);

GRANT SELECT, INSERT ON cdp_transform_runs TO postwave_app;

ALTER TABLE cdp_transform_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdp_transform_runs FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cdp_transform_runs;
CREATE POLICY tenant_isolation ON cdp_transform_runs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
