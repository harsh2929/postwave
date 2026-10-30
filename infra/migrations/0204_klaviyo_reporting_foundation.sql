-- 0204_klaviyo_reporting_foundation.sql
--
-- Klaviyo parity slice KLV-12: generic report-builder definitions, metric
-- registry, run snapshots, and export records shared by campaigns, flows,
-- forms, commerce, deliverability, and future product dashboards.

BEGIN;

CREATE TABLE report_metric_registry (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key             text NOT NULL,
    label           text NOT NULL,
    product_area    text NOT NULL
                    CHECK (product_area IN ('campaign','flow','form','onsite','commerce','deliverability','sms','push','reviews','helpdesk','agent','account','custom')),
    source          text NOT NULL DEFAULT '',
    aggregation     text NOT NULL DEFAULT 'count'
                    CHECK (aggregation IN ('count','unique_count','sum','avg','min','max','rate','last')),
    value_type      text NOT NULL DEFAULT 'number'
                    CHECK (value_type IN ('number','currency','percentage','duration','string','datetime')),
    dimensions      text[] NOT NULL DEFAULT '{}',
    filters         jsonb NOT NULL DEFAULT '{}',
    runtime_status  text NOT NULL DEFAULT 'supported'
                    CHECK (runtime_status IN ('supported','partial','planned','unsupported')),
    definition      jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE INDEX report_metric_registry_tenant_area_idx
    ON report_metric_registry (tenant_id, product_area, runtime_status, key);

CREATE TRIGGER report_metric_registry_set_updated_at
    BEFORE UPDATE ON report_metric_registry
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON report_metric_registry TO postwave_app;

ALTER TABLE report_metric_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_metric_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_metric_registry
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON report_metric_registry
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE report_definitions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,
    description     text NOT NULL DEFAULT '',
    product_area    text NOT NULL DEFAULT 'custom'
                    CHECK (product_area IN ('campaign','flow','form','onsite','commerce','deliverability','sms','push','reviews','helpdesk','agent','account','custom')),
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','archived')),
    metrics         jsonb NOT NULL DEFAULT '[]',
    dimensions      text[] NOT NULL DEFAULT '{}',
    filters         jsonb NOT NULL DEFAULT '{}',
    time_range      jsonb NOT NULL DEFAULT '{}',
    visualization   text NOT NULL DEFAULT 'table'
                    CHECK (visualization IN ('table','line','bar','funnel','scorecard')),
    schedule        jsonb NOT NULL DEFAULT '{}',
    owner_user_id   uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_definitions_tenant_status_idx
    ON report_definitions (tenant_id, status, updated_at DESC);

CREATE TRIGGER report_definitions_set_updated_at
    BEFORE UPDATE ON report_definitions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON report_definitions TO postwave_app;

ALTER TABLE report_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_definitions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON report_definitions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE report_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    definition_id   uuid REFERENCES report_definitions(id) ON DELETE SET NULL,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed','cancelled')),
    request         jsonb NOT NULL DEFAULT '{}',
    result          jsonb NOT NULL DEFAULT '{}',
    error           text NOT NULL DEFAULT '',
    rows_total      integer NOT NULL DEFAULT 0,
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_runs_tenant_recent_idx
    ON report_runs (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON report_runs TO postwave_app;

ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_runs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON report_runs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE report_exports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id          uuid REFERENCES report_runs(id) ON DELETE CASCADE,
    definition_id   uuid REFERENCES report_definitions(id) ON DELETE SET NULL,
    format          text NOT NULL DEFAULT 'csv'
                    CHECK (format IN ('csv','json','xlsx','parquet')),
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','ready','failed','expired')),
    storage_url     text NOT NULL DEFAULT '',
    bytes_total     bigint NOT NULL DEFAULT 0,
    rows_total      integer NOT NULL DEFAULT 0,
    error           text NOT NULL DEFAULT '',
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_exports_tenant_recent_idx
    ON report_exports (tenant_id, created_at DESC);

CREATE TRIGGER report_exports_set_updated_at
    BEFORE UPDATE ON report_exports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON report_exports TO postwave_app;

ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_exports
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON report_exports
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
