-- 0268_audit_alert_operators.sql
--
-- Extend audit_alert_rules with richer match operators and add
-- bidirectional SOC ticketing channels (ServiceNow, Jira, PagerDuty).
--
-- Prior to this migration, all rules were glob-based — they matched
-- on action_glob only. Real SOCs need more: "5 failed logins in 5
-- minutes", "auth rate 50% above 7-day baseline", "off-hours admin
-- impersonation". We add an operator_kind enum + operator_config
-- jsonb so a single rules table covers all four patterns:
--
--   glob              — existing behaviour; action_glob match
--   threshold_window  — count > N events in M-minute window
--                       (optionally grouped by actor/resource)
--   rate_deviation    — events/min deviates X% from N-day baseline
--   outlier           — UEBA: impossible_travel | escalation_chain |
--                       off_hours
--
-- operator_config is kind-specific JSON:
--   glob:             {} (uses existing action_glob)
--   threshold_window: { count: 5, window_min: 5, group_by: 'actor_label' }
--   rate_deviation:   { deviation_pct: 50, baseline_days: 7 }
--   outlier:          { kind: 'impossible_travel'|'escalation_chain'|'off_hours' }
--
-- Channel kinds extended to include SOC ticketing systems with
-- bidirectional sync. Outbound: create incident with deep-link back
-- to Postwave. Inbound: webhook from the SOC system updates the
-- mapped incident_status so the operator sees "resolved in Jira"
-- without leaving Postwave.
--
-- audit_alert_incidents is the mapping table: one row per fired-rule
-- ↔ external-incident pair. The inbound_webhook handler upserts on
-- (rule_id, external_system, external_incident_id) to keep state
-- in sync.

BEGIN;

ALTER TABLE audit_alert_rules
    ADD COLUMN IF NOT EXISTS operator_kind text NOT NULL DEFAULT 'glob'
        CHECK (operator_kind IN ('glob','threshold_window','rate_deviation','outlier')),
    ADD COLUMN IF NOT EXISTS operator_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Extend channel_kind to include bidirectional SOC ticketing.
-- Drop the old constraint first; if it has a different generated name
-- the IF EXISTS keeps the migration idempotent.
ALTER TABLE audit_alert_rules
    DROP CONSTRAINT IF EXISTS audit_alert_rules_channel_kind_check;
ALTER TABLE audit_alert_rules
    ADD CONSTRAINT audit_alert_rules_channel_kind_check
        CHECK (channel_kind IN ('email','slack','webhook','servicenow','jira','pagerduty'));

CREATE TABLE IF NOT EXISTS audit_alert_incidents (
    id                   bigserial PRIMARY KEY,
    rule_id              uuid NOT NULL REFERENCES audit_alert_rules(id) ON DELETE CASCADE,
    tenant_id            uuid NOT NULL,
    audit_id             bigint,
    external_system      text NOT NULL
        CHECK (external_system IN ('servicenow','jira','pagerduty')),
    external_incident_id text NOT NULL,
    incident_status      text,
    incident_url         text,
    last_synced_at       timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (rule_id, external_system, external_incident_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_alert_incidents_rule
    ON audit_alert_incidents (rule_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_alert_incidents_tenant
    ON audit_alert_incidents (tenant_id, external_system);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_alert_incidents TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_alert_incidents_id_seq TO postwave_app;

ALTER TABLE audit_alert_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_alert_incidents AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
