-- 0043_slack_integrations.sql
--
-- Per-tenant Slack incoming-webhook integrations.
--
-- A tenant pastes an incoming-webhook URL from Slack
-- (https://hooks.slack.com/services/T.../B.../xxx) plus a list of
-- Postwave event types they want piped to Slack. The dispatcher then
-- formats each matching event as a Slack message (text + Block Kit
-- blocks) instead of the raw Postwave envelope.
--
-- The webhook URL itself is the secret here — anyone holding it can
-- post to that channel — so we encrypt it with the platform KEK
-- (same envelope cipher that wraps webhook signing secrets in 0039).
-- The plaintext is recoverable on the gateway side because the
-- dispatcher needs it to issue the HTTP POST. A DB dump alone is
-- useless to an attacker.
--
-- channel_hint is a tenant-visible label (e.g. "#marketing-alerts")
-- that's surfaced in the admin UI so operators can pick the right row
-- without revealing the URL. Optional.

BEGIN;

CREATE TABLE slack_integrations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Envelope-encrypted incoming-webhook URL. The plaintext is shown
    -- to the tenant exactly once at create time (same UX as API key
    -- minting); subsequent reads return only channel_hint.
    webhook_url_envelope bytea NOT NULL,
    channel_hint         text,
    events               text[] NOT NULL DEFAULT '{}',
    enabled              boolean NOT NULL DEFAULT true,
    last_delivery_status text,                              -- 'success' | 'failed' | NULL
    last_delivery_at     timestamptz,
    last_delivery_error  text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slack_integrations_tenant_idx
    ON slack_integrations (tenant_id, enabled);

CREATE INDEX slack_integrations_events_idx
    ON slack_integrations USING GIN (events);

CREATE TRIGGER slack_integrations_set_updated_at
    BEFORE UPDATE ON slack_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON slack_integrations TO postwave_app;

ALTER TABLE slack_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_integrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON slack_integrations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive policy for the cross-tenant dispatcher. Same pattern as
-- tenant_webhooks (0017): the worker binds app.outbox_worker='true'
-- before SELECTing the URL it needs to post.
CREATE POLICY slack_integrations_worker_select ON slack_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY slack_integrations_worker_update ON slack_integrations
    AS PERMISSIVE
    FOR UPDATE
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
