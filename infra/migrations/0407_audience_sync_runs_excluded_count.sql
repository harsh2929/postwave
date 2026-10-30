-- 0407_audience_sync_runs_excluded_count.sql
--
-- Consent-Safe Activation Firewall (feature #2), additive run-shape
-- changes:
--
--   1. audience_sync_runs.excluded_count — how many profiles the
--      firewall withheld from THIS run (one row in
--      activation_exclusion_receipts per excluded profile). Surfaced in
--      the desktop runs slideover as "− N" and gates the "Download
--      receipt" link. 0 for runs that predate the firewall or had no
--      exclusions.
--
--   2. audience_syncs.required_consent_purpose — nullable per-sync
--      override (D3, approved). NULL = use the default
--      destination-type → purpose mapping
--      (PurposeForDestinationType: webhook→email_marketing,
--      meta/google_ads/…→targeted_ads, warehouse/zerocopy→profiling).
--      A non-NULL value forces a specific consent.Purpose so an operator
--      can opt a sync into a stricter gate (e.g. a CRM webhook that
--      actually feeds an ad audience) without waiting on a product
--      feature.
--
-- Both changes are ADDITIVE. ADD COLUMN ... NOT NULL DEFAULT 0 (constant
-- default) is lock-minimal from PG 11+. ADD COLUMN ... (nullable, no
-- default) is metadata-only. Prior releases simply ignore both columns,
-- so this migration is rollback-safe (no-op on rollback).
--
-- The CHECK on required_consent_purpose pins the five canonical
-- consent.Purpose values (purpose.go) so a typo can't silently disable
-- the gate; NULL is explicitly allowed for "use the default mapping".

BEGIN;

ALTER TABLE audience_sync_runs
    ADD COLUMN IF NOT EXISTS excluded_count integer NOT NULL DEFAULT 0;

ALTER TABLE audience_syncs
    ADD COLUMN IF NOT EXISTS required_consent_purpose text;

ALTER TABLE audience_syncs
    DROP CONSTRAINT IF EXISTS audience_syncs_required_consent_purpose_check;

ALTER TABLE audience_syncs
    ADD CONSTRAINT audience_syncs_required_consent_purpose_check
    CHECK (
        required_consent_purpose IS NULL
        OR required_consent_purpose IN (
            'email_marketing',
            'sms_marketing',
            'profiling',
            'targeted_ads',
            'ai_processing'
        )
    );

COMMIT;
