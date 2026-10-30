-- 0029_commerce_shopify_foundations.sql
--
-- Shopify-first commerce foundations that sit on top of the 0028 commerce
-- tables: public webhook lookup by shop domain and idempotent webhook claims.

BEGIN;

-- Public Shopify webhooks arrive with only the shop domain, not a Postwave
-- tenant header. The API sets this transaction-local value before lookup.
DROP POLICY IF EXISTS commerce_integrations_shopify_webhook_lookup ON commerce_integrations;
CREATE POLICY commerce_integrations_shopify_webhook_lookup ON commerce_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (
        provider = 'shopify'
        AND lower(shop_domain) = lower(NULLIF(current_setting('app.shopify_shop_domain', true), ''))
    );

CREATE TABLE IF NOT EXISTS commerce_webhook_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id uuid NOT NULL REFERENCES commerce_integrations(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS commerce_webhook_events_tenant_idx
    ON commerce_webhook_events (tenant_id, integration_id, topic, created_at DESC);

DROP TRIGGER IF EXISTS commerce_webhook_events_set_updated_at ON commerce_webhook_events;
CREATE TRIGGER commerce_webhook_events_set_updated_at
    BEFORE UPDATE ON commerce_webhook_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON commerce_webhook_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE commerce_webhook_events_id_seq TO postwave_app;

ALTER TABLE commerce_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commerce_webhook_events;
CREATE POLICY tenant_isolation ON commerce_webhook_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
