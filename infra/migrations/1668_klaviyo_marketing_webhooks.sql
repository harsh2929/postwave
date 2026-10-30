-- Native Klaviyo system-webhook receiver foundation.
-- Public callbacks resolve a marketing integration by provider + opaque token
-- before tenant context exists, then claim each Klaviyo delivery id before
-- recording a webhook-mode sync run.

CREATE TABLE IF NOT EXISTS marketing_webhook_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES marketing_integrations(id) ON DELETE CASCADE,
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
    UNIQUE (tenant_id, integration_id, provider, webhook_id)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS marketing_webhook_events_tenant_idx
    ON marketing_webhook_events (tenant_id, integration_id, provider, topic, created_at DESC);

DROP TRIGGER IF EXISTS marketing_webhook_events_set_updated_at ON marketing_webhook_events;
CREATE TRIGGER marketing_webhook_events_set_updated_at
    BEFORE UPDATE ON marketing_webhook_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON marketing_webhook_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE marketing_webhook_events_id_seq TO postwave_app;

ALTER TABLE marketing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON marketing_webhook_events;
CREATE POLICY tenant_isolation ON marketing_webhook_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE marketing_sync_runs
    DROP CONSTRAINT IF EXISTS marketing_sync_runs_run_mode_check;

ALTER TABLE marketing_sync_runs
    ADD CONSTRAINT marketing_sync_runs_run_mode_check
    CHECK (run_mode IN ('manual', 'scheduled', 'backfill', 'retry', 'dry_run', 'webhook'));

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS marketing_integrations_klaviyo_webhook_token_unique
    ON marketing_integrations ((COALESCE(NULLIF(settings->>'klaviyo_webhook_token', ''), NULLIF(settings->>'marketing_webhook_token', ''), NULLIF(settings->>'webhook_token', ''))))
    WHERE provider = 'klaviyo'
      AND status IN ('connected', 'active', 'paused', 'error')
      AND COALESCE(NULLIF(settings->>'klaviyo_webhook_token', ''), NULLIF(settings->>'marketing_webhook_token', ''), NULLIF(settings->>'webhook_token', '')) IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS marketing_integrations_klaviyo_webhook_token_idx
    ON marketing_integrations (provider, (COALESCE(NULLIF(settings->>'klaviyo_webhook_token', ''), NULLIF(settings->>'marketing_webhook_token', ''), NULLIF(settings->>'webhook_token', ''))))
    WHERE provider = 'klaviyo'
      AND status IN ('connected', 'active', 'paused', 'error')
      AND COALESCE(NULLIF(settings->>'klaviyo_webhook_token', ''), NULLIF(settings->>'marketing_webhook_token', ''), NULLIF(settings->>'webhook_token', '')) IS NOT NULL;

DROP POLICY IF EXISTS marketing_integrations_webhook_lookup ON marketing_integrations;
CREATE POLICY marketing_integrations_webhook_lookup ON marketing_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND provider = NULLIF(current_setting('app.marketing_webhook_provider', true), '')
        AND COALESCE(NULLIF(settings->>'klaviyo_webhook_token', ''), NULLIF(settings->>'marketing_webhook_token', ''), NULLIF(settings->>'webhook_token', '')) =
            NULLIF(current_setting('app.marketing_webhook_token', true), '')
    );
