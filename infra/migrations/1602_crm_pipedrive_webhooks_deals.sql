-- Pipedrive CRM native webhooks and deal-event runtime support.

ALTER TABLE crm_sync_runs
    DROP CONSTRAINT IF EXISTS crm_sync_runs_run_mode_check;

ALTER TABLE crm_sync_runs
    ADD CONSTRAINT crm_sync_runs_run_mode_check
    CHECK (run_mode IN ('manual', 'scheduled', 'backfill', 'retry', 'dry_run', 'webhook'));

CREATE TABLE IF NOT EXISTS crm_webhook_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES crm_integrations(id) ON DELETE CASCADE,
    provider       text NOT NULL,
    webhook_id     text NOT NULL,
    topic          text NOT NULL,
    body_sha256    text NOT NULL,
    status         text NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'processed', 'failed')),
    attempts       integer NOT NULL DEFAULT 1,
    last_error     text,
    processed_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, webhook_id)
);

CREATE INDEX IF NOT EXISTS crm_webhook_events_tenant_idx
    ON crm_webhook_events (tenant_id, integration_id, provider, topic, created_at DESC);

DROP TRIGGER IF EXISTS crm_webhook_events_set_updated_at ON crm_webhook_events;
CREATE TRIGGER crm_webhook_events_set_updated_at
    BEFORE UPDATE ON crm_webhook_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON crm_webhook_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE crm_webhook_events_id_seq TO postwave_app;

ALTER TABLE crm_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm_webhook_events;
CREATE POLICY tenant_isolation ON crm_webhook_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public Pipedrive webhooks resolve by provider webhook id before tenant context exists.
-- The API binds app.crm_provider and app.crm_webhook_id for the lookup transaction.
DROP POLICY IF EXISTS crm_integrations_pipedrive_webhook_lookup ON crm_integrations;
CREATE POLICY crm_integrations_pipedrive_webhook_lookup ON crm_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.crm_provider', true), '')
        AND provider = 'pipedrive'
        AND status IN ('connected', 'active')
        AND (
            settings->>'pipedrive_webhook_id' =
                NULLIF(current_setting('app.crm_webhook_id', true), '')
            OR COALESCE(settings->'pipedrive_webhook_ids', '[]'::jsonb) ?
                NULLIF(current_setting('app.crm_webhook_id', true), '')
        )
    );
