-- 0500_three_state_email_consent.sql
--
-- SUB-044 — Three-state consent per channel (Subscribed / Unsubscribed /
-- Never).
--
-- The subscriber_emails table (migration 0452) already tracks per-address
-- consent_status independently of suppression via a CHECK constraint, with the
-- vocabulary {subscribed, unsubscribed, pending, unknown}. The 2026 consent
-- expectation (Klaviyo three-state subscriber status, Mailchimp
-- subscribed/unsubscribed/cleaned) wants an EXPLICIT "never subscribed" state
-- that is distinct from "unknown": 'unknown' means "we have no recorded signal
-- either way" whereas 'never_subscribed' is a positive assertion that the
-- address was added (e.g. captured at checkout) but the contact has never
-- opted in to receive mail on it. Keeping the two apart lets the email channel
-- represent all three meaningful states — Subscribed / Unsubscribed / Never —
-- independently of the suppressed flag.
--
-- This migration widens the existing CHECK to admit 'never_subscribed'. No
-- table-shape change and no data change: every existing row keeps its current
-- value. This is the DB half of a minimal expand-contract widening; the
-- backend validation (normalizeConsentStatus) and the frontend/OpenAPI enum
-- are updated alongside it.
--
-- rollback-strategy: additive (widening a CHECK). A hard rollback would first
-- have to migrate any 'never_subscribed' rows back to 'unknown', then re-add
-- the narrower CHECK; there is no destructive change to undo here.

BEGIN;

-- The original CHECK was defined inline in 0452, so Postgres assigned it the
-- conventional auto-generated name subscriber_emails_consent_status_check.
-- Drop-if-exists then re-add the widened constraint. Guarded so the migration
-- is safe to re-run in a test fixture that may have already applied it.
ALTER TABLE subscriber_emails
    DROP CONSTRAINT IF EXISTS subscriber_emails_consent_status_check;

ALTER TABLE subscriber_emails
    ADD CONSTRAINT subscriber_emails_consent_status_check
    CHECK (consent_status IN (
        'subscribed', 'unsubscribed', 'pending', 'unknown', 'never_subscribed'
    ));

COMMENT ON CONSTRAINT subscriber_emails_consent_status_check ON subscriber_emails IS
    'SUB-044 three-state consent: subscribed/unsubscribed/never_subscribed are the three meaningful states; pending/unknown remain for double-opt-in and no-signal.';

COMMIT;
