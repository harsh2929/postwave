-- 0044_discord_integrations.sql
--
-- Per-tenant Discord webhook integrations. Same shape as
-- slack_integrations (0043) — copy-paste-with-renames is intentional;
-- the wire contract is narrow enough that abstracting it costs more
-- than it saves.
--
-- Discord webhook URL pattern:
--   https://discord.com/api/webhooks/<channel_id>/<token>

BEGIN;

CREATE TABLE discord_integrations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_url_envelope bytea NOT NULL,
    channel_hint         text,
    events               text[] NOT NULL DEFAULT '{}',
    enabled              boolean NOT NULL DEFAULT true,
    last_delivery_status text,
    last_delivery_at     timestamptz,
    last_delivery_error  text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discord_integrations_tenant_idx
    ON discord_integrations (tenant_id, enabled);

CREATE INDEX discord_integrations_events_idx
    ON discord_integrations USING GIN (events);

CREATE TRIGGER discord_integrations_set_updated_at
    BEFORE UPDATE ON discord_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON discord_integrations TO postwave_app;

ALTER TABLE discord_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_integrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discord_integrations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY discord_integrations_worker_select ON discord_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY discord_integrations_worker_update ON discord_integrations
    AS PERMISSIVE
    FOR UPDATE
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
