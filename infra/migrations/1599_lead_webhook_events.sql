-- Durable idempotency for native lead/CMS provider webhooks.
-- Wix explicitly documents duplicate, delayed, and resent webhook deliveries;
-- this ledger lets public webhook handlers claim a delivery before ingest.

CREATE TABLE IF NOT EXISTS lead_webhook_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES lead_integrations(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS lead_webhook_events_tenant_idx
    ON lead_webhook_events (tenant_id, integration_id, provider, topic, created_at DESC);

DROP TRIGGER IF EXISTS lead_webhook_events_set_updated_at ON lead_webhook_events;
CREATE TRIGGER lead_webhook_events_set_updated_at
    BEFORE UPDATE ON lead_webhook_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON lead_webhook_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE lead_webhook_events_id_seq TO postwave_app;

ALTER TABLE lead_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON lead_webhook_events;
CREATE POLICY tenant_isolation ON lead_webhook_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
