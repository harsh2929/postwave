-- 0306_sto_cold_start_fallback_hierarchy.sql
--
-- Tiered cold-start fallback for send-time-optimization
-- (sto-cold-start-fallback-hierarchy, P1).
--
-- Before this migration, a cold subscriber (< MinOpens weighted events)
-- has best_send_hour = NULL, and the only fallback is the per-campaign
-- tenant mean computed at schedule time inside loadCampaignRecipients().
-- That gives nothing for the per-subscriber GET endpoint: it returns
-- best_hour_utc=-1 with no signal about what the system would actually
-- use, so the desktop renders "no data" and the operator gives up.
--
-- 2026 SOTA tiers a hierarchy:
--
--   * Klaviyo Personalized Send Time falls back through
--     similar-profiles → account-level mean → re-personalize on next
--     engagement.
--   * MoEngage Best Time to Send (BTS) falls back from per-user BTS
--     → most-popular workspace hour → marketer-specified custom
--     fallback.
--   * Iterable STO uses per-user → list-level → tenant-default in the
--     same order.
--   * Braze Intelligent Timing falls back to channel-wide modal hour
--     when a recipient has insufficient history.
--
-- Postwave needs at least two tiers beyond per-subscriber. This
-- migration installs the two tenant-level rungs:
--
--   1. tenant_modal_hour_cache — nightly aggregate of the most
--      common best_send_hour across the tenant's enabled subscribers.
--      The send_time_opt worker writes this row on its tick; the
--      fallback resolver reads it. Cached (not computed on every
--      cold-subscriber GET) because the underlying scan is over the
--      full subscribers table and at 100k+ subscribers per tenant
--      that'd 5xx the GET. Confidence label 'tenant_fallback' is
--      surfaced to the caller so the UI can flag "this is a tenant
--      average, not a personal recommendation".
--
--   2. tenant_send_settings.fallback_hour_utc — per-tenant explicit
--      override (0..167 hour-of-week). When set, this beats the
--      computed aggregate: it gives the marketer the same
--      "marketer-specified custom fallback" rung MoEngage exposes.
--      NULL preserves legacy posture (use the cache; if cache is
--      empty, the campaign-scheduler mean still applies).
--
-- The fallback HIERARCHY documented in send_time_opt/send_time_opt.go:
--
--   tier 1: subscriber.best_send_hour              (confidence='subscriber')
--   tier 2: tenant_send_settings.fallback_hour_utc (confidence='tenant_override')
--   tier 3: tenant_modal_hour_cache.modal_hour     (confidence='tenant_fallback')
--   tier 4: campaign-scheduler mean (legacy)       (confidence='tenant_mean')
--
-- Operator note: this migration is non-destructive and additive —
-- existing best_send_hour reads keep working unchanged.

BEGIN;

-- 1) Tenant-level modal-hour cache. One row per tenant. The send_time_opt
-- worker recomputes this nightly (or on demand from a backfill CLI);
-- between recomputes the row is the source of truth for cold-subscriber
-- fallback hour.
CREATE TABLE IF NOT EXISTS tenant_modal_hour_cache (
    tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- modal_hour is hour-of-week 0..167 (Sunday 00:00 UTC = 0, matching
    -- the rest of the STO surface). NULL means "not yet computed" —
    -- the resolver then walks down to the legacy campaign-scheduler
    -- mean rung.
    modal_hour     smallint,
    -- sample_size is the count of enabled subscribers whose
    -- best_send_hour fed into the aggregate. Surfaced to the desktop
    -- so the UI can hide low-confidence aggregates (< 30 subscribers
    -- with history) the same way the segment endpoint does.
    sample_size    integer NOT NULL DEFAULT 0,
    computed_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_modal_hour_cache_range_chk
        CHECK (modal_hour IS NULL OR (modal_hour BETWEEN 0 AND 167)),
    CONSTRAINT tenant_modal_hour_cache_sample_chk
        CHECK (sample_size >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_modal_hour_cache TO postwave_app;

ALTER TABLE tenant_modal_hour_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modal_hour_cache FORCE  ROW LEVEL SECURITY;

-- Same NULLIF-guarded RLS idiom used across the codebase; raw
-- ('')::uuid would crash on an unset app.tenant_id GUC.
CREATE POLICY tenant_isolation ON tenant_modal_hour_cache
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_modal_hour_cache
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) Per-tenant explicit override on tenant_send_settings. NULL =
-- "no override; use the computed cache (or the legacy mean if the
-- cache is empty)". An integer 0..167 pins the cold-subscriber
-- fallback hour to a marketer-specified value — the equivalent of
-- MoEngage's "marketer-specified custom fallback" rung.
ALTER TABLE tenant_send_settings
    ADD COLUMN IF NOT EXISTS fallback_hour_utc smallint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_fallback_hour_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_fallback_hour_chk
            CHECK (fallback_hour_utc IS NULL
                OR (fallback_hour_utc BETWEEN 0 AND 167));
    END IF;
END$$;

COMMIT;
