-- 0391_audit_alert_rules_notify_slack.sql
--
-- feat/full-surface-wiring: security alerts → Slack.
--
-- Per-rule opt-in flag: when an audit alert rule fires, ALSO fan the
-- fire out to the tenant's first-class Slack integration (slackint)
-- via the existing slack.deliver outbox — on top of (not instead of)
-- the rule's primary channel_kind. The Slack integration must be
-- enabled and subscribed to the "audit.alert.fired" event for the
-- fan-out to enqueue anything (slackint.Dispatcher.Fire filters on
-- the integration's events array).
--
-- This is distinct from channel_kind='slack', which posts to a
-- per-rule raw webhook URL in channel_config. notify_slack rides the
-- managed integration (encrypted URL, outbox retries, delivery
-- bookkeeping) instead.
--
-- rollback-strategy: ALTER TABLE audit_alert_rules DROP COLUMN
-- notify_slack — additive column with a default; old code ignores it.

BEGIN;

ALTER TABLE audit_alert_rules
    ADD COLUMN IF NOT EXISTS notify_slack BOOLEAN NOT NULL DEFAULT false;

COMMIT;
