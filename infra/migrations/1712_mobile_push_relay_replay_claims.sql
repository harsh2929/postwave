-- Durable idempotency claims for the signed first-party Expo push relay.
-- A process-local cache is insufficient when the API runs multiple replicas:
-- the same captured delivery could otherwise be replayed once per replica.

BEGIN;

CREATE TABLE mobile_push_relay_claims (
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_id      uuid        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, webhook_id, idempotency_key),
    CHECK (expires_at > claimed_at)
);

CREATE INDEX mobile_push_relay_claims_expiry_idx
    ON mobile_push_relay_claims (tenant_id, expires_at);

GRANT SELECT, INSERT, DELETE ON mobile_push_relay_claims TO postwave_app;

ALTER TABLE mobile_push_relay_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_push_relay_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY mobile_push_relay_claims_tenant_isolation
    ON mobile_push_relay_claims
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
