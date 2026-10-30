-- 0255_list_versions.sql
--
-- GAP-LS-062: per-list snapshot rows so "Over time by version"
-- analytics can render — point-in-time member_count + change_summary
-- per version. HubSpot list analytics parity.
--
-- Append-only table; a daily-tick worker (lands later) writes one
-- row per (tenant, list_id) with the auto-incrementing version
-- per-list. version is computed at write time as
-- COALESCE(MAX(version), 0) + 1 inside a tx that locks the rows for
-- the list to avoid races.

BEGIN;

CREATE TABLE IF NOT EXISTS list_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    list_id         uuid NOT NULL,
    version         int NOT NULL CHECK (version > 0),
    snapshot_at     timestamptz NOT NULL DEFAULT now(),
    member_count    int NOT NULL DEFAULT 0,
    change_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, list_id, version)
);

CREATE INDEX IF NOT EXISTS list_versions_tenant_list_idx
    ON list_versions (tenant_id, list_id, snapshot_at DESC);

GRANT SELECT, INSERT ON list_versions TO postwave_app;

ALTER TABLE list_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON list_versions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON list_versions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
