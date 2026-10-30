-- 0135_audit_alerts.sql
--
-- Audit-log alerting rules.
--
-- Operators subscribe to specific audit_log events ("email me when
-- an admin exports tenant data"; "Slack me on impersonation start";
-- "webhook me on BAA revoke"). The matcher worker runs every 30s,
-- walks rules with last_audit_id < max(audit_log.id), evaluates
-- each row against each rule's match criteria, and dispatches.
--
-- This turns the audit_log from forensic-only into preventive — a
-- security team can react to high-severity events within the
-- matcher's tick.
--
-- Rule match criteria (all-of):
--   action_glob       shell-glob on audit_log.action (e.g.
--                     "impersonation.*", "*.deleted", "campaign.send")
--   actor_type        exact match (optional)
--   actor_label_glob  shell-glob (optional)
--   resource_type     exact match (optional)
--
-- Delivery channels:
--   email   { to: "security@acme.com", subject_prefix: "[Postwave]" }
--   slack   { webhook_url: "https://hooks.slack.com/services/..." }
--   webhook { url, hmac_secret? }  (signed using outbound_webhooks
--                                     signing primitive)

BEGIN;

CREATE TABLE IF NOT EXISTS audit_alert_rules (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    name            text NOT NULL,
    enabled         boolean NOT NULL DEFAULT true,
    -- Match criteria. Empty fields mean "don't filter on this
    -- dimension". action_glob is required (a rule that matches
    -- everything is rarely what the operator wants).
    action_glob       text NOT NULL,
    actor_type        text,
    actor_label_glob  text,
    resource_type     text,
    -- Delivery: kind + per-kind config blob.
    channel_kind    text NOT NULL CHECK (channel_kind IN ('email','slack','webhook')),
    channel_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Worker cursor: last audit_log.id this rule has been
    -- evaluated against. NULL = never evaluated; the worker
    -- bootstraps it to max(audit_log.id) so we don't fire
    -- retroactive alerts on enable.
    last_audit_id   bigint,
    -- Lifecycle telemetry. Operators love seeing "fired 4 times in
    -- the last 24h" on the rule list.
    fired_count     bigint NOT NULL DEFAULT 0,
    last_fired_at   timestamptz,
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_alert_rules_tenant
    ON audit_alert_rules (tenant_id, enabled);

CREATE INDEX IF NOT EXISTS idx_audit_alert_rules_worker
    ON audit_alert_rules (last_audit_id NULLS FIRST)
    WHERE enabled = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_alert_rules TO postwave_app;

ALTER TABLE audit_alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_alert_rules AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

-- audit_alert_fires: log of every dispatch (one row per (rule,
-- audit_log row) pair). Useful for "show me the last 50 alerts
-- this rule fired" + replay debugging.
CREATE TABLE IF NOT EXISTS audit_alert_fires (
    id              bigserial PRIMARY KEY,
    rule_id         uuid NOT NULL REFERENCES audit_alert_rules(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL,
    audit_id        bigint NOT NULL,
    delivered       boolean NOT NULL DEFAULT false,
    delivery_error  text,
    fired_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_alert_fires_rule
    ON audit_alert_fires (rule_id, fired_at DESC);

GRANT SELECT, INSERT, UPDATE ON audit_alert_fires TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_alert_fires_id_seq TO postwave_app;

ALTER TABLE audit_alert_fires ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_alert_fires AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
