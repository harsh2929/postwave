-- SETC-037 follow-up — decouple the notification_feed row's DEDUP/IDENTITY role
-- from its IN-APP VISIBILITY.
--
-- The fanout writes exactly one notification_feed row per logical notification;
-- that row is the durable identity + the (tenant,user,dedupe_key) dedup anchor
-- for EVERY channel, including the outbound webhook. But it is ALSO what the
-- in-app bell reads. So when a user turns the in-app channel OFF for a category
-- while leaving the webhook ON, the row must still be written (webhook dedup
-- needs it) yet must NOT appear in the bell/unread count.
--
-- `suppressed` is that visibility bit: false = normal in-app notification
-- (every existing row, and every notification whose in-app channel is on),
-- true = written only as a dedup/webhook anchor and hidden from the feed reads.
--
-- Additive and behavior-preserving: DEFAULT false stamps every existing row as
-- visible, so no current notification changes. No RLS/policy/index change (the
-- table already has its tenant RLS policy + grants to postwave_app).

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE notification_feed
    ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false;

COMMIT;
