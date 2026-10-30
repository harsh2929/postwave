-- 0017_webhooks.sql
--
-- Outbound webhook subscriptions + delivery log. Tenant-scoped admin
-- surface. Secrets are stored hashed (HMAC-SHA256 of the original) so the
-- plaintext is shown exactly once at create time. Mirrors how Stripe and
-- GitHub manage webhook signing secrets.

BEGIN;

CREATE TABLE webhooks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    url          text NOT NULL,
    events       text[] NOT NULL DEFAULT '{}',
    secret_hash  text NOT NULL,
    status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'paused', 'failing')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhooks_tenant_idx ON webhooks (tenant_id);

CREATE TRIGGER webhooks_set_updated_at
    BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks TO postwave_app;

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhooks
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- webhook_deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
    id           bigserial PRIMARY KEY,
    webhook_id   uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event        text NOT NULL,
    status_code  int NOT NULL DEFAULT 0,
    attempt      int NOT NULL DEFAULT 1,
    response_ms  int NOT NULL DEFAULT 0,
    error        text,
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_deliveries_webhook_at_idx
    ON webhook_deliveries (webhook_id, at DESC);
CREATE INDEX webhook_deliveries_tenant_idx
    ON webhook_deliveries (tenant_id, at DESC);

GRANT SELECT, INSERT ON webhook_deliveries TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE webhook_deliveries_id_seq TO postwave_app;

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_deliveries
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
