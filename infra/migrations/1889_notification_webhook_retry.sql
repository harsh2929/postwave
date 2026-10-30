-- 1889_notification_webhook_retry.sql
--
-- The notification webhook is the only channel with neither retry nor a way to
-- ask for one.
--
-- Chat (Slack/Teams/Discord) runs through the outbox: its handlers return the
-- delivery error and the outbox retries with backoff up to ten attempts. Web
-- push got its own sweep in 1886/1887/1888. This channel has neither:
-- `Fanout.Dispatch` returns `[]Delivery` and no error, so a failed
-- `Webhook.Post` is logged, cannot propagate to whatever queued the dispatch,
-- and nothing anywhere tries again.
--
-- Migration 1885 gave it a delivery record. This gives that record the two
-- things a sweep needs, and both were learned the hard way on web push an hour
-- earlier:
--
--   * `next_retry_at`, because a ledger that records the outcome and not when
--     to try again is not re-sendable, only observable.
--   * a worker-visible RLS policy, because a cross-tenant sweep runs under
--     `app.outbox_worker` with no tenant GUC — under a RESTRICTIVE policy that
--     evaluates `tenant_id = NULL` and the sweep silently finds nothing, which
--     reads exactly like "nothing was due".
--
-- The retry needs the destination URL as well, and that lives in the user's
-- notification preferences rather than here. Copying it into the delivery row
-- would duplicate a mutable setting: a person who fixes a broken Slack URL
-- would still have the old one retried at them.

BEGIN;

ALTER TABLE notification_webhook_deliveries
    ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

COMMENT ON COLUMN notification_webhook_deliveries.next_retry_at IS
    'When a failed post becomes eligible again. NULL once delivered or retired. '
    'The destination URL is deliberately NOT stored here: it lives in the '
    'user''s notification preferences, and a copy would retry a URL they have '
    'since corrected.';

CREATE INDEX IF NOT EXISTS notification_webhook_deliveries_retry_idx
    ON notification_webhook_deliveries (next_retry_at)
    WHERE next_retry_at IS NOT NULL;

DROP POLICY IF EXISTS tenant_isolation ON notification_webhook_deliveries;
CREATE POLICY tenant_isolation ON notification_webhook_deliveries
    AS RESTRICTIVE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
