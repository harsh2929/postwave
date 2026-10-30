-- Self-contained schema for the loyalty webhook-ingest end-to-end test
-- (ingest_e2e_db_test.go). Mirrors migrations 1541 (table + FORCE RLS +
-- tenant_isolation), the 1558 expanded provider CHECK, 1612 (ingest lookup
-- index + policy), and 1616 (provider-CHECK relax). Reuses the cluster-wide
-- non-superuser role `postwave_app` so FORCE ROW LEVEL SECURITY is enforced.
--
-- Usage (fresh throwaway DB):
--   createdb ingest_e2e
--   psql -d ingest_e2e -v ON_ERROR_STOP=1 -f apps/api/internal/loyalty_integrations/testdata/ingest_e2e_setup.sql
--   DATABASE_URL='postgres://postwave_app:postwave_app_dev@localhost:5432/ingest_e2e?sslmode=disable' \
--     go test ./apps/api/internal/loyalty_integrations/ -run E2E -count=1
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
GRANT SELECT, INSERT, DELETE ON tenants TO postwave_app;

CREATE TABLE loyalty_integrations (
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
    -- 1558 expanded enumerated CHECK (dropped below by the 1616 relax).
    CONSTRAINT loyalty_integrations_provider_check
      CHECK (provider IN ('smile','loyaltylion','rivo','referralcandy','growave','marsello','antavo','friendbuy','talkable')),
    CONSTRAINT loyalty_integrations_status_check
      CHECK (status IN ('connected','active','paused','error','disconnected')),
    CONSTRAINT loyalty_integrations_provider_name_unique UNIQUE (tenant_id, provider, name)
);
CREATE TRIGGER loyalty_integrations_set_updated_at BEFORE UPDATE ON loyalty_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON loyalty_integrations TO postwave_app;
ALTER TABLE loyalty_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_integrations
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);

CREATE TABLE loyalty_sync_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES loyalty_integrations(id) ON DELETE CASCADE,
    run_mode text NOT NULL DEFAULT 'manual',
    status text NOT NULL DEFAULT 'completed',
    cursor_from text NOT NULL DEFAULT '', cursor_to text NOT NULL DEFAULT '',
    members_seen int NOT NULL DEFAULT 0, members_upserted int NOT NULL DEFAULT 0,
    events_seen int NOT NULL DEFAULT 0, events_tracked int NOT NULL DEFAULT 0,
    rows_failed int NOT NULL DEFAULT 0, error_message text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}',
    started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON loyalty_sync_runs TO postwave_app;
ALTER TABLE loyalty_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_sync_runs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);

-- 1612 ingest lookup (index + SELECT policy keyed by the URL token).
CREATE INDEX loyalty_integrations_ingest_idx
    ON loyalty_integrations ((settings->>'loyalty_ingest_token'))
    WHERE status IN ('connected','active','paused','error');
CREATE POLICY loyalty_integrations_ingest_lookup ON loyalty_integrations
    FOR SELECT USING (
        status IN ('connected','active','paused','error')
        AND settings->>'loyalty_ingest_token' = NULLIF(current_setting('app.loyalty_ingest_token', true), '')
    );

-- 1616 relax: drop the enumerated provider CHECK so any sanitized provider
-- (long-tail / bridge desks) is set-up-able via webhook ingest.
ALTER TABLE loyalty_integrations DROP CONSTRAINT IF EXISTS loyalty_integrations_provider_check;

\echo '== loyalty ingest e2e schema ready =='
