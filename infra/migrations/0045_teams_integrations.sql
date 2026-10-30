-- 0045_teams_integrations.sql
--
-- Per-tenant Microsoft Teams incoming-webhook integrations. Same shape
-- as slack_integrations and discord_integrations.
--
-- Teams accepts two webhook payload formats:
--   - Legacy "Connector" MessageCard JSON.
--   - Adaptive Cards (newer; via Power Automate / Workflows).
--
-- We emit MessageCard because it's the only format the Office 365
-- Connector accepts directly, and Adaptive Cards would require a
-- Workflows-side template anyway. If MS deprecates Connectors, swap
-- the formatter; the rest of the integration is unchanged.

BEGIN;

CREATE TABLE teams_integrations (
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

CREATE INDEX teams_integrations_tenant_idx
    ON teams_integrations (tenant_id, enabled);

CREATE INDEX teams_integrations_events_idx
    ON teams_integrations USING GIN (events);

CREATE TRIGGER teams_integrations_set_updated_at
    BEFORE UPDATE ON teams_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON teams_integrations TO postwave_app;

ALTER TABLE teams_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_integrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teams_integrations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY teams_integrations_worker_select ON teams_integrations
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY teams_integrations_worker_update ON teams_integrations
    AS PERMISSIVE
    FOR UPDATE
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
