-- 1717_mobile_push_devices.sql
--
-- Replace the first-party mobile push relay built on tenant-admin outbound
-- webhooks with a session-user/device resource. Expo tokens are never placed
-- in URLs or returned by list endpoints. The API stores only an envelope-
-- encrypted token plus fixed-size digests used for rotation and uniqueness.

BEGIN;

-- Disable legacy relay subscriptions so a signed-out/shared device cannot keep
-- receiving through an old generic webhook. Preserve the rows as migration
-- evidence and for operator review instead of deleting customer-owned data.
-- This deliberately matches only the first-party relay path; other customer
-- webhooks are untouched.
UPDATE webhooks
   SET status = 'paused',
       updated_at = now()
 WHERE url ~ '^https://[^/?#]+/api/public/mobile/expo-push(?:\?|$)'
   AND status <> 'paused';

CREATE TABLE mobile_push_devices (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_key_digest     bytea NOT NULL UNIQUE
                              CHECK (octet_length(device_key_digest) = 32),
    token_digest          bytea NOT NULL UNIQUE
                              CHECK (octet_length(token_digest) = 32),
    token_envelope        bytea NOT NULL
                              CHECK (octet_length(token_envelope) BETWEEN 1 AND 8192),
    platform              text NOT NULL CHECK (platform IN ('ios', 'android')),
    enabled_events        text[] NOT NULL DEFAULT '{}',
    status                text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'revoked')),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    last_registered_at    timestamptz NOT NULL DEFAULT now(),
    last_delivery_at      timestamptz,
    revoked_at            timestamptz,
    CHECK (cardinality(enabled_events) <= 32)
);

CREATE TRIGGER mobile_push_devices_set_updated_at
    BEFORE UPDATE ON mobile_push_devices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mobile_push_deliveries (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id             uuid NOT NULL REFERENCES mobile_push_devices(id) ON DELETE CASCADE,
    event_type            text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
    entity_id             text CHECK (entity_id IS NULL OR length(entity_id) <= 256),
    idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    status                text NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'accepted', 'failed', 'revoked')),
    expo_ticket_id        text CHECK (expo_ticket_id IS NULL OR length(expo_ticket_id) <= 256),
    error_code            text CHECK (error_code IS NULL OR length(error_code) <= 128),
    attempts              integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 20),
    next_retry_at         timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (device_id, idempotency_key)
);

CREATE TRIGGER mobile_push_deliveries_set_updated_at
    BEFORE UPDATE ON mobile_push_deliveries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON mobile_push_devices TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mobile_push_deliveries TO postwave_app;

ALTER TABLE mobile_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_push_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE mobile_push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_push_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY mobile_push_devices_tenant_isolation ON mobile_push_devices
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY mobile_push_deliveries_tenant_isolation ON mobile_push_deliveries
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Registration is the one intentional cross-tenant operation: a physical
-- installation that signs into a different workspace must atomically move its
-- own device row instead of leaving a stale delivery behind. The handler uses
-- db.WithWorkerScope and proves possession of a 256-bit device key before it
-- updates the row. Ordinary tenant requests never set this transaction-local
-- worker marker.
CREATE POLICY mobile_push_devices_worker_claim ON mobile_push_devices
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
