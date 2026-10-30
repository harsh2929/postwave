-- 0121_status_subscribers_hardening.sql
--
-- Hotfix for status_subscribers brute-force + UUID-auth weaknesses.
--
-- Issues fixed:
--   1. SMS confirm_token is a 6-digit OTP — only 10^6 keyspace and no
--      per-row binding meant any 6-digit guess matched some row.
--   2. Confirm + Unsubscribe queries had no per-row id binding, so a
--      single brute-force run hit every subscriber simultaneously.
--   3. No expiry on the confirm_token, so the brute-force budget was
--      unbounded.
--   4. Unsubscribe accepted `OR id::text = $1` — the subscriber id
--      (returned in the Subscribe response) was usable as an
--      unsubscribe credential.
--
-- Changes:
--   * Add confirm_token_expires_at: tokens expire after 15 minutes.
--   * Add confirm_attempts: increment on failed match; lock the row
--     after 5 failures (the API enforces this).
--   * Add unsubscribe_token: separate from confirm_token, persists
--     after confirmation so the recipient can unsub forever.
--   * Add ip_address + user_agent for rate-limiting + audit.

BEGIN;

ALTER TABLE status_subscribers
    ADD COLUMN IF NOT EXISTS confirm_token_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirm_attempts         int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unsubscribe_token        text,
    ADD COLUMN IF NOT EXISTS subscribe_ip             text,
    ADD COLUMN IF NOT EXISTS subscribe_user_agent     text;

-- Backfill: any existing row needs an unsubscribe_token. gen_random_uuid()
-- produces a 36-character secret which is plenty for unsub authorization.
UPDATE status_subscribers
   SET unsubscribe_token = gen_random_uuid()::text
 WHERE unsubscribe_token IS NULL;

-- Going forward unsubscribe_token must always be present.
ALTER TABLE status_subscribers
    ALTER COLUMN unsubscribe_token SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_status_subscribers_unsub_token
    ON status_subscribers (unsubscribe_token);

COMMIT;
