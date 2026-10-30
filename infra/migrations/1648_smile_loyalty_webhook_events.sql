-- Durable idempotency and tenantless routing for Smile.io app webhooks.
-- Smile app webhooks carry account_id in the signed body and use
-- Smile-Signature/Smile-Timestamp HMAC verification before canonical ingest.

CREATE TABLE IF NOT EXISTS loyalty_webhook_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES loyalty_integrations(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS loyalty_webhook_events_tenant_idx
    ON loyalty_webhook_events (tenant_id, integration_id, provider, topic, created_at DESC);

DROP TRIGGER IF EXISTS loyalty_webhook_events_set_updated_at ON loyalty_webhook_events;
CREATE TRIGGER loyalty_webhook_events_set_updated_at
    BEFORE UPDATE ON loyalty_webhook_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON loyalty_webhook_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE loyalty_webhook_events_id_seq TO postwave_app;

ALTER TABLE loyalty_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON loyalty_webhook_events;
CREATE POLICY tenant_isolation ON loyalty_webhook_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS loyalty_integrations_smile_account_idx
    ON loyalty_integrations ((settings->>'account_id'))
    WHERE provider = 'smile' AND status IN ('connected', 'active', 'paused', 'error');

CREATE INDEX IF NOT EXISTS loyalty_integrations_smile_account_alt_idx
    ON loyalty_integrations ((settings->>'smile_account_id'))
    WHERE provider = 'smile' AND status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS loyalty_integrations_smile_webhook_lookup ON loyalty_integrations;
CREATE POLICY loyalty_integrations_smile_webhook_lookup ON loyalty_integrations
    FOR SELECT
    USING (
        provider = 'smile'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND (
            settings->>'account_id' = NULLIF(current_setting('app.smile_account_id', true), '')
            OR settings->>'smile_account_id' = NULLIF(current_setting('app.smile_account_id', true), '')
        )
    );
