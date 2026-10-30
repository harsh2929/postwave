-- 1890_notification_preferences_worker_read.sql
--
-- The webhook retry sweep needs the destination it is retrying to.
--
-- Third time this exact shape has appeared in one day, which is the point of
-- writing it down. A cross-tenant worker runs under `app.outbox_worker` with no
-- tenant GUC; every table its claim query touches must admit that scope, or the
-- join silently yields nothing and the sweep reports "nothing was due". The
-- previous two were `web_push_deliveries` (1887) and `web_push_subscriptions`
-- (1888). This is `notification_preferences`, which holds the webhook URL the
-- retry posts to.
--
-- It is silent every time, and always in the same misleading direction: the
-- sweep succeeds, returns zero, and looks exactly like a healthy idle worker.
-- Only a test that asserts a notification was actually re-delivered catches it.
--
-- SELECT ONLY. The worker reads a destination to post to it. Preferences are
-- the person's own settings and nothing automated has any business changing
-- them — least of all a retry sweep.

BEGIN;

DROP POLICY IF EXISTS worker_read ON notification_preferences;
CREATE POLICY worker_read ON notification_preferences
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMENT ON POLICY worker_read ON notification_preferences IS
    'Read-only, worker-scoped access for the notification webhook retry sweep, '
    'which is cross-tenant and joins this table for the destination URL. '
    'Writes stay tenant-scoped: a sweep must never alter a person''s settings.';

COMMIT;
