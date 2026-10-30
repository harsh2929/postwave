-- Durable idempotency and stricter routing for native subscription webhooks.
-- Recharge and tokenized push-only subscription/shipping callbacks can claim a
-- delivery before canonical ingest so provider retries do not duplicate
-- subscription, shipment, or lifecycle events.

CREATE TABLE IF NOT EXISTS subscription_webhook_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES subscription_integrations(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS subscription_webhook_events_tenant_idx
    ON subscription_webhook_events (tenant_id, integration_id, provider, topic, created_at DESC);

DROP TRIGGER IF EXISTS subscription_webhook_events_set_updated_at ON subscription_webhook_events;
CREATE TRIGGER subscription_webhook_events_set_updated_at
    BEFORE UPDATE ON subscription_webhook_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON subscription_webhook_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE subscription_webhook_events_id_seq TO postwave_app;

ALTER TABLE subscription_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscription_webhook_events;
CREATE POLICY tenant_isolation ON subscription_webhook_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscription_integrations_active_ingest_token_unique
    ON subscription_integrations ((settings->>'subscription_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error')
      AND NULLIF(settings->>'subscription_ingest_token', '') IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscription_integrations_provider_ingest_idx
    ON subscription_integrations (provider, (settings->>'subscription_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error')
      AND NULLIF(settings->>'subscription_ingest_token', '') IS NOT NULL;

DROP POLICY IF EXISTS subscription_integrations_ingest_lookup ON subscription_integrations;
CREATE POLICY subscription_integrations_ingest_lookup ON subscription_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND provider = NULLIF(current_setting('app.subscription_ingest_provider', true), '')
        AND settings->>'subscription_ingest_token' = NULLIF(current_setting('app.subscription_ingest_token', true), '')
    );
