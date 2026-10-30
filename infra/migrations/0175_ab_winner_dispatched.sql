-- 0175_ab_winner_dispatched.sql
--
-- Closes the missing piece of the A/B test auto-rollout flow.
-- Migration 0015 introduced campaign_ab_settings.sample_evaluated_at
-- ("the sample phase concluded; winner queued for remaining audience")
-- but the dispatcher that READS that flag and actually enqueues the
-- winning variant to the held-back audience was deferred.
--
-- This column lets that dispatcher mark its work idempotent: once
-- winner_dispatched_at is set, the rollout has been queued; future
-- scheduler ticks skip it. The column also doubles as audit (when
-- did the auto-rollout fire? which child campaign did it spawn?).
--
-- The dispatcher itself lives in apps/api/internal/abtests/rollout.go
-- and is wired into the existing 5-minute scheduler in
-- apps/api/internal/abtests/scheduler.go.

BEGIN;

ALTER TABLE campaign_ab_settings
    ADD COLUMN IF NOT EXISTS winner_dispatched_at timestamptz,
    -- Child-campaign id the dispatcher created. Nullable in case the
    -- rollout creator returns an error mid-flight (the dispatcher
    -- still flips winner_dispatched_at to "we tried, don't retry";
    -- operators can re-trigger manually).
    ADD COLUMN IF NOT EXISTS winner_rollout_campaign_id uuid;

CREATE INDEX IF NOT EXISTS campaign_ab_settings_due_rollout_idx
    ON campaign_ab_settings (sample_evaluated_at)
    WHERE winner_dispatched_at IS NULL
      AND sample_evaluated_at IS NOT NULL
      AND winning_variant_id IS NOT NULL;

COMMIT;
