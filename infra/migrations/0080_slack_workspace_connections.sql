-- 0080_slack_workspace_connections.sql
--
-- Slack workspace connections for the approval bot + slash commands.
--
-- One row per (tenant, slack_team) pair. The bot token is envelope-
-- encrypted at rest using the same KEK helper that wraps webhook URLs
-- (see slackint.Repo + sending.EnvelopeEncryptor — wired in
-- apps/api/main.go).
--
-- The OAuth start endpoint redirects to Slack with the configured
-- SLACK_CLIENT_ID and a signed state token; the callback exchanges the
-- returned code for a bot token via Slack's `oauth.v2.access`. The row
-- is upserted on (tenant_id, slack_team_id), so re-installing into the
-- same workspace rotates the bot token without growing the table.
--
-- A side table `slack_approval_messages` records the (channel, ts) of
-- the message we posted for an approval so the interactions handler
-- can update the original message in place ("✓ Approved by @user")
-- without modifying the approvals table itself.

BEGIN;

-- ---------------------------------------------------------------------------
-- slack_workspace_connections
-- ---------------------------------------------------------------------------
CREATE TABLE slack_workspace_connections (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slack_team_id            text NOT NULL,
    slack_team_name          text NOT NULL DEFAULT '',
    bot_token_encrypted      bytea NOT NULL,
    default_channel_id       text NOT NULL DEFAULT '',
    default_channel_name     text NOT NULL DEFAULT '',
    connected_by_user_id     uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slack_team_id)
);

CREATE INDEX slack_workspace_connections_tenant_idx
    ON slack_workspace_connections (tenant_id);
CREATE INDEX slack_workspace_connections_team_idx
    ON slack_workspace_connections (slack_team_id);

CREATE TRIGGER slack_workspace_connections_set_updated_at
    BEFORE UPDATE ON slack_workspace_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON slack_workspace_connections TO postwave_app;

ALTER TABLE slack_workspace_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_workspace_connections FORCE  ROW LEVEL SECURITY;

-- Tenant isolation: the canonical PERMISSIVE-FOR-ALL shape used by
-- 0079's fixups. We deliberately do not add a sibling RESTRICTIVE
-- policy here because RLS lints in this tree treat the PERMISSIVE
-- policy as authoritative; mirror what 0079 lays down for new tables.
CREATE POLICY tenant_visible ON slack_workspace_connections
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The OAuth callback runs WITHOUT a tenant context (Slack hits the
-- redirect URL directly). The handler verifies the signed state token,
-- which carries the tenant id, then opens a tenant-scoped tx via
-- db.WithTenant before the upsert — so the policy above still gates
-- the write.
--
-- The interactions/commands webhooks similarly run without a tenant
-- context; they look up the connection by slack_team_id (cross-tenant
-- read) under a `app.slack_team_lookup` guard so RLS still pins the
-- query.
CREATE POLICY slack_team_lookup ON slack_workspace_connections
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (
        current_setting('app.slack_team_lookup', true) <> ''
        AND slack_team_id = current_setting('app.slack_team_lookup', true)
    );

-- ---------------------------------------------------------------------------
-- slack_approval_messages
-- ---------------------------------------------------------------------------
-- Sidecar that maps an approval id to the Slack message we posted for
-- it. Lives in its own table so the approvals package doesn't grow a
-- Slack-shaped column.
CREATE TABLE slack_approval_messages (
    approval_id   uuid PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_id    text NOT NULL,
    message_ts    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slack_approval_messages_tenant_idx
    ON slack_approval_messages (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON slack_approval_messages TO postwave_app;

ALTER TABLE slack_approval_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_approval_messages FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON slack_approval_messages
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The interactions handler resolves an approval id without a tenant
-- context (Slack signs the request, not a tenant header). Allow that
-- specific lookup via the same `app.public_approval_id` guard the
-- approvals package already uses for one-click decide links.
CREATE POLICY slack_approval_message_public_lookup ON slack_approval_messages
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (approval_id = NULLIF(current_setting('app.public_approval_id', true), '')::uuid);

COMMIT;
