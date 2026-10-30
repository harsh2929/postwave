-- 1885_notification_webhook_deliveries.sql
--
-- The last notification channel with no delivery record.
--
-- `notifyfanout` drives four channels: the feed row, web push, mobile push, and
-- a per-user notification webhook (SETC-037) — how Slack and generic
-- destinations are reached. After migrations 1883 and 1884 the first three all
-- record what happened to a send. The webhook channel does this
-- (fanout.go:302):
--
--     if err := f.Webhook.Post(...); err != nil {
--         log.Warn("notifyfanout: webhook post failed", ...)
--     }
--
-- A log line, and nothing durable. The person configured a Slack destination
-- precisely so they would hear about approvals; when the post fails they hear
-- nothing, and no query anywhere can tell them it was attempted.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD: an idempotency key. Unlike web push,
-- this channel is unreachable from outside the fanout, and the fanout only
-- reaches it when `NotifyDeduped` reports the feed row was newly created — a
-- redelivered dispatch returns created=false and skips every channel. Adding a
-- key would be protection against a duplicate that cannot currently occur, and
-- inventing an idempotency contract for a path that has no second caller is how
-- a mechanism nobody exercises ends up trusted.
--
-- The UNIQUE constraint is on (notification_id, user_id) instead: one feed row
-- is one logical notification for one person, so at most one webhook attempt
-- record per pair, updated in place on a retry. That is the same guarantee an
-- idempotency key would give here, expressed in the identity the channel
-- already has.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_webhook_deliveries (
    id         uuid        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL,
    -- The feed row this mirrors: the cross-channel identity every other channel
    -- already carries. Not FK'd, so a delivery record outlives a feed row
    -- trimmed by retention — the evidence that we tried to tell someone must
    -- not disappear with the notification itself.
    notification_id uuid   NOT NULL,
    event_type text        NOT NULL DEFAULT '',
    -- "slack" | "generic", matching the poster's payload shapes.
    kind       text        NOT NULL DEFAULT '',
    status     text        NOT NULL DEFAULT 'pending',
    error      text        NOT NULL DEFAULT '',
    attempts   integer     NOT NULL DEFAULT 0,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT notification_webhook_deliveries_status_check
        CHECK (status = ANY (ARRAY['pending', 'sent', 'failed'])),
    CONSTRAINT notification_webhook_deliveries_error_len
        CHECK (char_length(error) <= 2000)
);

COMMENT ON TABLE notification_webhook_deliveries IS
    'One row per (feed notification, user) webhook attempt. The fourth and last '
    'notifyfanout channel to get a delivery record; before this a failed post '
    'was a log line and nothing else, so a person whose Slack destination was '
    'broken had no way to discover it.';

CREATE UNIQUE INDEX IF NOT EXISTS notification_webhook_deliveries_identity_idx
    ON notification_webhook_deliveries (tenant_id, notification_id, user_id);

-- "What did we try to tell this person, and did it land."
CREATE INDEX IF NOT EXISTS notification_webhook_deliveries_user_idx
    ON notification_webhook_deliveries (tenant_id, user_id, created_at DESC);

ALTER TABLE notification_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_webhook_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON notification_webhook_deliveries;
CREATE POLICY tenant_isolation ON notification_webhook_deliveries
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON notification_webhook_deliveries;
CREATE POLICY tenant_visible ON notification_webhook_deliveries
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_webhook_deliveries TO postwave_app;

COMMIT;
