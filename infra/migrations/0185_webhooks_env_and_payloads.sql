-- 0185_webhooks_env_and_payloads.sql
--
-- Refined Webhooks remaining items:
--
-- 1. environment tag on both webhook tables — production | staging |
--    development. PR 1 of multi-environment work: ship the column +
--    UI surface so admins can label their subscriptions. Dispatcher
--    routing by env is a future PR (today the field is purely a
--    label for organisation + filtering).
--
-- 2. webhook_test_payloads — per-webhook named test payloads so
--    admins can save a few representative JSON bodies once and re-fire
--    them from the Test dialog instead of re-typing each time.

BEGIN;

ALTER TABLE webhooks
    ADD COLUMN environment text NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'staging', 'development'));

ALTER TABLE outbound_webhooks
    ADD COLUMN environment text NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'staging', 'development'));

CREATE TABLE webhook_test_payloads (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_id  uuid NOT NULL,             -- soft FK; works for both webhooks + outbound_webhooks
    direction   text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    name        text NOT NULL,
    body_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, webhook_id, name)
);

CREATE INDEX webhook_test_payloads_tenant_webhook_idx
    ON webhook_test_payloads (tenant_id, webhook_id, created_at DESC);

ALTER TABLE webhook_test_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_test_payloads FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_test_payloads
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_test_payloads TO postwave_app;

COMMIT;
