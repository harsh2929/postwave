-- 0184_webhook_alert_prefs.sql
--
-- Refined Webhooks PR 3: per-user, per-tenant alert preferences.
-- Each user opts into the events that should email them:
--
--   • auto_disabled  — webhook hits the consecutive-failure threshold
--   • failure_rate   — 24h failure rate > threshold_pct
--   • latency        — 24h p99 latency > threshold_ms
--
-- The actual alert worker (a cron-style sweep that reads this table
-- and sends emails) is intentionally deferred — same pattern as the
-- dashboard digest prefs. This migration ships the storage so users
-- can opt in; the sender lands in a follow-up.

BEGIN;

CREATE TABLE webhook_alert_prefs (
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    notify_auto_disabled  boolean NOT NULL DEFAULT true,
    notify_failure_rate   boolean NOT NULL DEFAULT false,
    failure_rate_pct      int     NOT NULL DEFAULT 20  CHECK (failure_rate_pct BETWEEN 1 AND 100),
    notify_latency        boolean NOT NULL DEFAULT false,
    latency_ms            int     NOT NULL DEFAULT 5000 CHECK (latency_ms > 0 AND latency_ms <= 600000),
    last_alerted_at       timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id)
);

ALTER TABLE webhook_alert_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_alert_prefs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_alert_prefs
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_alert_prefs TO postwave_app;

COMMIT;
