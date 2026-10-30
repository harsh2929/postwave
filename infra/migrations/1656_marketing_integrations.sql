-- 1656_marketing_integrations.sql
-- First-party marketing automation connector control plane.

BEGIN;

CREATE TABLE IF NOT EXISTS marketing_integrations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'connected',
    scopes          text[] NOT NULL DEFAULT '{}',
    credentials_ref text NOT NULL DEFAULT '',
    settings        jsonb NOT NULL DEFAULT '{}',
    sync_cursor     text NOT NULL DEFAULT '',
    last_sync_at    timestamptz,
    error_message   text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT marketing_integrations_provider_check
      CHECK (provider IN ('klaviyo')),
    CONSTRAINT marketing_integrations_status_check
      CHECK (status IN ('connected', 'active', 'paused', 'error', 'disconnected')),
    CONSTRAINT marketing_integrations_provider_name_unique
      UNIQUE (tenant_id, provider, name)
);

CREATE INDEX IF NOT EXISTS marketing_integrations_tenant_provider_idx
    ON marketing_integrations (tenant_id, provider, status);

DROP TRIGGER IF EXISTS marketing_integrations_set_updated_at ON marketing_integrations;
CREATE TRIGGER marketing_integrations_set_updated_at
    BEFORE UPDATE ON marketing_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_integrations TO postwave_app;

ALTER TABLE marketing_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_integrations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON marketing_integrations;
CREATE POLICY tenant_isolation ON marketing_integrations
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS marketing_sync_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id  uuid NOT NULL REFERENCES marketing_integrations(id) ON DELETE CASCADE,
    run_mode        text NOT NULL DEFAULT 'manual',
    status          text NOT NULL DEFAULT 'completed',
    cursor_from     text NOT NULL DEFAULT '',
    cursor_to       text NOT NULL DEFAULT '',
    profiles_seen   integer NOT NULL DEFAULT 0,
    events_seen     integer NOT NULL DEFAULT 0,
    lists_seen      integer NOT NULL DEFAULT 0,
    rows_failed     integer NOT NULL DEFAULT 0,
    error_message   text NOT NULL DEFAULT '',
    metadata        jsonb NOT NULL DEFAULT '{}',
    started_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT marketing_sync_runs_run_mode_check
      CHECK (run_mode IN ('manual', 'scheduled', 'backfill', 'retry', 'dry_run')),
    CONSTRAINT marketing_sync_runs_status_check
      CHECK (status IN ('running', 'completed', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS marketing_sync_runs_tenant_integration_idx
    ON marketing_sync_runs (tenant_id, integration_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON marketing_sync_runs TO postwave_app;

ALTER TABLE marketing_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_sync_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON marketing_sync_runs;
CREATE POLICY tenant_isolation ON marketing_sync_runs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
