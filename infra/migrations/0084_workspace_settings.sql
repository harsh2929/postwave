-- 0084_workspace_settings.sql
--
-- Settings UIs (workspace, notifications, privacy/retention) get persistence.
-- Three small per-tenant tables, all RLS-gated on app.tenant_id, all idempotent.
-- Pairs with the new internal/settings package and the wiring in main.go.
--
-- Tables:
--   1. workspace_settings        — display name, default reply-to, timezone,
--                                  brand color, logo URL. One row per tenant.
--   2. notification_preferences  — per-USER prefs (email triggers + digest
--                                  frequency). Tenant column carried forward
--                                  for RLS gating.
--   3. retention_policies        — audit_log/email_event/subscriber retention
--                                  windows. Per-tenant. The audit-log-trim
--                                  cron is expected to consult this row when
--                                  it lands (TODO comment in the API).
--
-- All migrations idempotent: CREATE TABLE IF NOT EXISTS, DROP POLICY IF
-- EXISTS before CREATE POLICY (Postgres has no CREATE POLICY IF NOT EXISTS
-- as of 16). The PERMISSIVE FOR ALL TO postwave_app pattern matches the
-- canonical RLS shape installed in 0079.

BEGIN;

-- citext is required for case-insensitive email columns.
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- workspace_settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_settings (
    tenant_id            uuid PRIMARY KEY,
    display_name         text,
    default_reply_to     citext,
    timezone             text NOT NULL DEFAULT 'UTC',
    brand_color          text,
    logo_url             text,
    updated_by_user_id   uuid,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_settings TO postwave_app;

ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON workspace_settings;
CREATE POLICY tenant_visible ON workspace_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id                     uuid PRIMARY KEY,
    tenant_id                   uuid NOT NULL,
    email_on_send_complete      boolean NOT NULL DEFAULT true,
    email_on_approval_request   boolean NOT NULL DEFAULT true,
    email_on_bounce_alert       boolean NOT NULL DEFAULT true,
    digest_frequency            text NOT NULL DEFAULT 'weekly',
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_preferences_digest_frequency_chk
        CHECK (digest_frequency IN ('daily', 'weekly', 'never'))
);

CREATE INDEX IF NOT EXISTS notification_preferences_tenant_idx
    ON notification_preferences (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO postwave_app;

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON notification_preferences;
CREATE POLICY tenant_visible ON notification_preferences
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- retention_policies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_policies (
    tenant_id                              uuid PRIMARY KEY,
    audit_log_retention_days               int NOT NULL DEFAULT 90,
    email_event_retention_days             int NOT NULL DEFAULT 365,
    unsubscribed_subscriber_retention_days int NOT NULL DEFAULT 730,
    updated_by_user_id                     uuid,
    updated_at                             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT retention_policies_audit_log_chk
        CHECK (audit_log_retention_days BETWEEN 7 AND 2555),
    CONSTRAINT retention_policies_email_event_chk
        CHECK (email_event_retention_days BETWEEN 30 AND 2555),
    CONSTRAINT retention_policies_unsub_chk
        CHECK (unsubscribed_subscriber_retention_days BETWEEN 7 AND 3650)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON retention_policies TO postwave_app;

ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON retention_policies;
CREATE POLICY tenant_visible ON retention_policies
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
