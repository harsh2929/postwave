-- 1623_web_push_subscriptions.sql
--
-- Server side of Web Push (RFC 8030 / 8291 / VAPID 8292). The web client shipped
-- a service-worker push handler but there was no server to register browser
-- PushSubscriptions or deliver to them. This table stores one row per browser
-- subscription (endpoint + the client's p256dh/auth keys); the sender encrypts
-- to those keys and POSTs to the endpoint. Dead endpoints (404/410) are pruned.

BEGIN;

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL,
    endpoint     text NOT NULL,
    p256dh       text NOT NULL,
    auth         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    -- Keyed by (tenant, user, endpoint): a re-subscribe by the same user
    -- refreshes their row; the same endpoint under a different user (shared
    -- browser) is a separate row, never a silent ownership transfer.
    UNIQUE (tenant_id, user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_user_idx
    ON web_push_subscriptions (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON web_push_subscriptions TO postwave_app;

ALTER TABLE web_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_push_subscriptions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON web_push_subscriptions;
CREATE POLICY tenant_isolation ON web_push_subscriptions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
