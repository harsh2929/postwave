-- 0088_outbound_webhooks.sql
--
-- Public outbound webhooks API. Customers configure URLs + a list of
-- event types; Postwave POSTs a signed JSON body whenever a matching
-- event fires for their tenant. The signing secret is HMAC-SHA256 and
-- envelope-encrypted at rest using the same EnvelopeCipher that wraps
-- Slack tokens (see internal/crypto/envelope.go) so a DB dump alone is
-- worthless to an attacker.
--
-- Two tables:
--
--   1. outbound_webhooks            — the subscription itself.
--   2. outbound_webhook_deliveries  — per-event, per-webhook attempt log
--                                     used by the retry worker.
--
-- The Zapier app is the first customer of this surface; the same shape
-- is what we'll document publicly under "Outbound webhooks".

BEGIN;

-- ---------------------------------------------------------------------------
-- outbound_webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_webhooks (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    url                   text NOT NULL,
    description           text,
    events                text[] NOT NULL,           -- e.g. {campaign.sent, subscriber.added}
    secret_envelope       bytea NOT NULL,            -- HMAC signing secret, envelope-encrypted
    active                boolean NOT NULL DEFAULT true,
    created_by_user_id    uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    last_succeeded_at     timestamptz,
    last_failed_at        timestamptz,
    consecutive_failures  int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_tenant
    ON outbound_webhooks (tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_events
    ON outbound_webhooks USING GIN (events);

GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_webhooks TO postwave_app;

ALTER TABLE outbound_webhooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON outbound_webhooks AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The retry worker runs without a tenant context (it sweeps every
-- tenant's pending deliveries in one pass) and binds
-- app.outbox_worker='true' before its SELECT — same pattern as
-- slack_integrations (0043). This permissive policy lets it through.
CREATE POLICY outbound_webhooks_worker_select ON outbound_webhooks
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY outbound_webhooks_worker_update ON outbound_webhooks
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------------
-- outbound_webhook_deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL,
    webhook_id                  uuid NOT NULL REFERENCES outbound_webhooks(id) ON DELETE CASCADE,
    event_type                  text NOT NULL,
    payload                     jsonb NOT NULL,
    attempt_count               int NOT NULL DEFAULT 0,
    next_attempt_at             timestamptz,           -- NULL once finalized
    status                      text NOT NULL DEFAULT 'pending', -- pending|delivered|exhausted|skipped
    last_status_code            int,
    last_response_body_truncated text,                 -- first 4KB of response body
    last_error                  text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    delivered_at                timestamptz
);

-- The worker's hot-path query: pending rows with next_attempt_at <= now().
-- Partial index keeps it tight even after millions of finalized rows
-- accumulate.
CREATE INDEX IF NOT EXISTS idx_owd_pending
    ON outbound_webhook_deliveries (next_attempt_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_owd_webhook
    ON outbound_webhook_deliveries (webhook_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_webhook_deliveries TO postwave_app;

ALTER TABLE outbound_webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON outbound_webhook_deliveries AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Worker policies mirror outbound_webhooks: cross-tenant scan + update
-- gated by app.outbox_worker='true'.
CREATE POLICY outbound_webhook_deliveries_worker_select ON outbound_webhook_deliveries
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY outbound_webhook_deliveries_worker_update ON outbound_webhook_deliveries
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY outbound_webhook_deliveries_worker_insert ON outbound_webhook_deliveries
    AS PERMISSIVE
    FOR INSERT
    TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
