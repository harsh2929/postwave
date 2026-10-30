-- 1618_integration_writeback.sql
--
-- Bidirectional integration write-back (reverse ETL). Until now connectors were
-- read-only — Postwave ingested/pulled from Shopify/HubSpot/etc. but never wrote
-- BACK. Klaviyo's integration moat is two-way: push a segment's members to
-- Shopify as customer tags/metafields, to HubSpot as contact properties + static
-- list membership, etc. These tables are the control plane for that: a tenant
-- registers a write-back target (provider + credential ref + tag/field mapping +
-- the source list/segment), and each run is audited.

CREATE TABLE IF NOT EXISTS writeback_targets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider        text NOT NULL,           -- shopify | hubspot | salesforce | pipedrive
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'active',
    credentials_ref text NOT NULL DEFAULT '',
    -- source audience + mapping live in settings:
    --   shop_domain / api_version (shopify), list_id (hubspot static list),
    --   source_list_id | source_segment_id, tags[] (applied to every member),
    --   field_map { subscriber_attr -> platform_field }
    settings        jsonb NOT NULL DEFAULT '{}',
    last_run_at     timestamptz,
    error_message   text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT writeback_targets_status_check
      CHECK (status IN ('active', 'paused', 'error', 'disconnected')),
    CONSTRAINT writeback_targets_provider_name_unique UNIQUE (tenant_id, provider, name)
);

CREATE INDEX IF NOT EXISTS writeback_targets_tenant_idx
    ON writeback_targets (tenant_id, provider, status);

DROP TRIGGER IF EXISTS writeback_targets_set_updated_at ON writeback_targets;
CREATE TRIGGER writeback_targets_set_updated_at
    BEFORE UPDATE ON writeback_targets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON writeback_targets TO postwave_app;
ALTER TABLE writeback_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE writeback_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON writeback_targets;
CREATE POLICY tenant_isolation ON writeback_targets
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS writeback_runs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    target_id         uuid NOT NULL REFERENCES writeback_targets(id) ON DELETE CASCADE,
    run_mode          text NOT NULL DEFAULT 'manual',
    status            text NOT NULL DEFAULT 'completed',
    members_seen      integer NOT NULL DEFAULT 0,
    matched           integer NOT NULL DEFAULT 0,   -- records found on the platform
    tags_written      integer NOT NULL DEFAULT 0,
    fields_written    integer NOT NULL DEFAULT 0,
    rows_failed       integer NOT NULL DEFAULT 0,
    error_message     text NOT NULL DEFAULT '',
    metadata          jsonb NOT NULL DEFAULT '{}',
    started_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT writeback_runs_run_mode_check
      CHECK (run_mode IN ('manual', 'scheduled', 'segment_change', 'dry_run')),
    CONSTRAINT writeback_runs_status_check
      CHECK (status IN ('running', 'completed', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS writeback_runs_tenant_target_idx
    ON writeback_runs (tenant_id, target_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON writeback_runs TO postwave_app;
ALTER TABLE writeback_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE writeback_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON writeback_runs;
CREATE POLICY tenant_isolation ON writeback_runs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
