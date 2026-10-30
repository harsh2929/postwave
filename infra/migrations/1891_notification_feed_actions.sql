-- 1891_notification_feed_actions.sql
--
-- Server-authored actions on the feed row.
--
-- Mobile push already carries actionable categories: `categoryForEvent` maps
-- `approval.requested` onto the `approval` category, and that is what puts
-- Approve and Reject on the lock screen. The feed row carries `deep_link` and
-- nothing else, so the same notification offers two buttons on a phone and
-- "open the page" in the desktop bell. That is a capability difference, not a
-- styling one.
--
-- The alternative to storing them is each client switching on `event_type` to
-- decide which buttons to draw — three copies of a rule that must agree with a
-- fourth on the server picking the push category. When they disagree, a client
-- offers an action the API refuses, and a button that fails is worse than a
-- button that is absent.
--
-- Stored ON THE ROW rather than resolved at read time, because the actions
-- offered are part of what the notification WAS. An approval that has since
-- been decided should not retroactively grow or lose buttons in somebody's
-- history, and a catalog change should not rewrite what a person was shown.
--
-- Default '[]' rather than NULL: every existing row genuinely has no actions,
-- and a nullable column would make "no actions" and "not yet computed"
-- indistinguishable to every reader.

BEGIN;

ALTER TABLE notification_feed
    ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN notification_feed.actions IS
    'Server-authored affordances for this notification, from '
    'notifications.ActionsForEvent — the same catalog that decides the mobile '
    'push category, so a phone cannot offer buttons the in-app feed does not '
    'know about. Authoring an action is not authorising it: every entry names '
    'an endpoint the API re-checks on invocation.';

ALTER TABLE notification_feed
    ADD CONSTRAINT notification_feed_actions_is_array
    CHECK (jsonb_typeof(actions) = 'array');

COMMIT;
