-- SETC-037 — expand notification preferences from a single email column into a
-- category × channel matrix.
--
-- BEHAVIORAL FACT that drives the backfill: today the single email_on_<cat>
-- column is NOT email-only — notifyfanout gates the WHOLE notification (feed +
-- web/mobile push + SSE) on it too. So a user who turned off email for a
-- category also gets no in-app/push for it. To split email and in-app into
-- independent channels WITHOUT changing anyone's current effective delivery,
-- inapp_on_<cat> is BACKFILLED from email_on_<cat> for existing rows (a blanket
-- true would silently re-subscribe every opted-out user to push on deploy).
-- The going-forward column DEFAULT is true (matches defaultPrefs' all-on).
--
-- webhook_on_<cat> is a brand-new outbound channel: default false (opt-in), and
-- notification_webhook_url NULL makes it a no-op regardless.
--
-- Purely additive on the small per-user notification_preferences table; no
-- RLS/policy/FK/index change (the table already has a tenant RLS policy + grants
-- to postwave_app).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. In-app / push, per category: add NULLable, backfill from email_on_<cat>,
--    THEN lock in the going-forward default (true) + NOT NULL.
ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS inapp_on_send_complete        boolean,
    ADD COLUMN IF NOT EXISTS inapp_on_approval_request     boolean,
    ADD COLUMN IF NOT EXISTS inapp_on_bounce_alert         boolean,
    ADD COLUMN IF NOT EXISTS inapp_on_deliverability_alert boolean,
    ADD COLUMN IF NOT EXISTS inapp_on_usage_alert          boolean;

UPDATE notification_preferences SET
    inapp_on_send_complete        = COALESCE(inapp_on_send_complete,        email_on_send_complete),
    inapp_on_approval_request     = COALESCE(inapp_on_approval_request,     email_on_approval_request),
    inapp_on_bounce_alert         = COALESCE(inapp_on_bounce_alert,         email_on_bounce_alert),
    inapp_on_deliverability_alert = COALESCE(inapp_on_deliverability_alert, email_on_deliverability_alert),
    inapp_on_usage_alert          = COALESCE(inapp_on_usage_alert,          email_on_usage_alert);

ALTER TABLE notification_preferences
    ALTER COLUMN inapp_on_send_complete        SET DEFAULT true,
    ALTER COLUMN inapp_on_send_complete        SET NOT NULL,
    ALTER COLUMN inapp_on_approval_request     SET DEFAULT true,
    ALTER COLUMN inapp_on_approval_request     SET NOT NULL,
    ALTER COLUMN inapp_on_bounce_alert         SET DEFAULT true,
    ALTER COLUMN inapp_on_bounce_alert         SET NOT NULL,
    ALTER COLUMN inapp_on_deliverability_alert SET DEFAULT true,
    ALTER COLUMN inapp_on_deliverability_alert SET NOT NULL,
    ALTER COLUMN inapp_on_usage_alert          SET DEFAULT true,
    ALTER COLUMN inapp_on_usage_alert          SET NOT NULL;

-- 2. Slack/generic outbound webhook, per category: brand-new channel, opt-in.
ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS webhook_on_send_complete        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS webhook_on_approval_request     boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS webhook_on_bounce_alert         boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS webhook_on_deliverability_alert boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS webhook_on_usage_alert          boolean NOT NULL DEFAULT false;

-- 3. Per-user webhook destination. url NULL = no webhook (channel no-ops).
ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS notification_webhook_url  text,
    ADD COLUMN IF NOT EXISTS notification_webhook_kind text NOT NULL DEFAULT 'slack'
        CHECK (notification_webhook_kind IN ('slack', 'generic'));

COMMIT;
