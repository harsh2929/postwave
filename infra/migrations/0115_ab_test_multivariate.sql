-- 0115_ab_test_multivariate.sql
--
-- Extends campaign_variants with send-time + sender (from_email)
-- dimensions so multivariate tests can vary more than just copy.
--
-- send_time_offset_minutes: number of minutes to delay this variant's
--   send relative to the parent campaign's scheduled_at. Lets a test
--   probe "send Tuesday 10am vs Tuesday 2pm" without operator having
--   to clone the campaign twice.
--
-- from_email: optional override of the sender email. Used to A/B test
--   "founder@acme.com" vs "team@acme.com". Falls back to the campaign's
--   default reply_to / from when NULL.
--
-- The early-stopping fields on campaign_ab_settings:
--   sample_pct: what fraction of the total audience runs through the
--     variant phase before auto-promoting. Default 100 (= every
--     recipient gets a variant, like today). Set to 20 to ship the
--     winner to the remaining 80% mid-flight (Mailchimp Premium model).
--   sample_evaluated_at: stamped when the sample phase concluded +
--     winner was promoted.

BEGIN;

ALTER TABLE campaign_variants
    ADD COLUMN IF NOT EXISTS send_time_offset_minutes int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS from_email               text;

ALTER TABLE campaign_ab_settings
    ADD COLUMN IF NOT EXISTS sample_pct           numeric(5,2) NOT NULL DEFAULT 100.00
                                  CHECK (sample_pct BETWEEN 1 AND 100),
    ADD COLUMN IF NOT EXISTS sample_evaluated_at  timestamptz;

COMMIT;
