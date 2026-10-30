-- 0538_subscribers_jurisdiction_change.sql
--
-- SUB-055 — Jurisdiction-change consent re-confirmation.
--
-- Why this migration:
--   Postwave already stores subscriber localization columns (country, language,
--   locale, region — migration 0414) and a signup_ip, but nothing infers the
--   data subject's legal JURISDICTION from that IP, and nothing reacts when a
--   subject's jurisdiction shifts (e.g. a US contact who relocates to the EU)
--   by triggering a fresh consent re-confirmation under the now-applicable
--   regime (GDPR / CASL / Quebec Law 25).
--
--   This migration adds three columns to subscribers:
--     - detected_jurisdiction:          ISO 3166-1 alpha-2 country inferred from
--                                       signup_ip (or last-seen IP). NULL until a
--                                       detector has run.
--     - jurisdiction_changed_at:        when the most recent drift was detected
--                                       (inferred jurisdiction != stored country).
--                                       NULL = no drift ever recorded.
--     - jurisdiction_reconfirm_required: set true on a drift into a stricter
--                                       regime; cleared when the subject
--                                       re-confirms (or declines) consent via
--                                       PATCH /subscribers/{id}/jurisdiction-reconfirm.
--
--   The drift detector (apps/api/internal/geolocation) compares the inferred
--   country against the stored country on Upsert and flips
--   jurisdiction_reconfirm_required when a re-confirmation regime applies; the
--   reconfirm handler records the consent receipt and clears the flag.
--
-- rollback-strategy: additive. Hard rollback = DROP COLUMN on the three columns.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS detected_jurisdiction text,
    ADD COLUMN IF NOT EXISTS jurisdiction_changed_at timestamptz,
    ADD COLUMN IF NOT EXISTS jurisdiction_reconfirm_required boolean NOT NULL DEFAULT false;

-- Pin detected_jurisdiction to a 2-letter ISO alpha-2 shape (or NULL). A
-- drifting detector cannot land an arbitrary string. Length check only — we
-- don't enumerate every ISO country here (that lives in the application
-- layer), but we guarantee the column holds a sane code.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'subscribers_detected_jurisdiction_chk'
    ) THEN
        ALTER TABLE subscribers
            ADD CONSTRAINT subscribers_detected_jurisdiction_chk
            CHECK (detected_jurisdiction IS NULL
                   OR detected_jurisdiction ~ '^[A-Z]{2}$');
    END IF;
END$$;

-- Partial index over the rows that need operator/UI attention — the
-- "show me everyone awaiting jurisdiction re-confirmation" read shape. Partial
-- so it stays tiny (the common case is the flag is false).
CREATE INDEX IF NOT EXISTS subscribers_jurisdiction_reconfirm_idx
    ON subscribers (tenant_id)
    WHERE jurisdiction_reconfirm_required;

COMMIT;
