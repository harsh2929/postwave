-- 0116_status_subscribers.sql
--
-- Status-page incident subscribers. Anyone can subscribe to an
-- incident-notification channel (email or SMS) without an account —
-- the status page is intentionally public and the subscriber form
-- below the live status grid posts to this table.
--
-- Why a single table (not separate email + sms): one row per
-- (channel, address) keeps confirmation + unsubscribe single-path.
-- A subscriber who wants both adds two rows.
--
-- Confirmation: every new row starts with confirmed_at = NULL and a
-- token in confirm_token. The confirmation URL POSTs back, sets
-- confirmed_at, and clears the token. SMS uses a 6-digit OTP code
-- instead of a long token.

BEGIN;

CREATE TABLE IF NOT EXISTS status_subscribers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         text NOT NULL CHECK (channel IN ('email','sms')),
    address         text NOT NULL,
    confirm_token   text NOT NULL,
    confirmed_at    timestamptz,
    unsubscribed_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, address)
);

CREATE INDEX IF NOT EXISTS idx_status_subscribers_confirmed
    ON status_subscribers (channel, confirmed_at)
    WHERE unsubscribed_at IS NULL;

-- Public can SELECT / INSERT (signup is anonymous); only the API
-- writes the confirmed_at + unsubscribed_at columns.
GRANT SELECT, INSERT, UPDATE ON status_subscribers TO postwave_app;

COMMIT;
