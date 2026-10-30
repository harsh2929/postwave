-- 0180_subscriber_churn_score.sql
--
-- Per-subscriber CHURN RISK score (0..100 — higher means more
-- likely to unsubscribe in the next 7 days) + a "frequency
-- preference" column that powers the smart-unsubscribe flow.
--
-- Why a separate column from engagement_score: engagement is a
-- TRAILING signal (open + click counts over 90d); churn is a
-- PREDICTION (probability of unsubscribe in the next window). Two
-- different signals operators want to act on differently.
--
-- The scorer is in apps/api/internal/subscriberscore/. It's a
-- pragmatic heuristic (recency-decay × frequency-mismatch) rather
-- than a trained model — gives 80% of the value without an MLOps
-- platform, and operators can audit/tune the weights via the
-- scoring_rules table that already exists.
--
-- frequency_preference enums:
--   * default    — subscriber accepts the tenant's normal cadence
--   * weekly     — chosen via smart-unsubscribe ("less often")
--   * monthly    — chosen via smart-unsubscribe ("much less often")
--   * paused     — temporary suppression with auto-reactivation
--                  (paused_until below)
-- Operators map these to send-gate decisions in their cron/sender;
-- the column itself is a hint, not a hard gate (RLS + suppression
-- list remain authoritative for compliance).

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS churn_score          smallint,
    ADD COLUMN IF NOT EXISTS churn_score_at       timestamptz,
    ADD COLUMN IF NOT EXISTS frequency_preference text NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS paused_until         timestamptz;

ALTER TABLE subscribers
    DROP CONSTRAINT IF EXISTS subscribers_frequency_preference_check;
ALTER TABLE subscribers
    ADD CONSTRAINT subscribers_frequency_preference_check
        CHECK (frequency_preference IN ('default','weekly','monthly','paused'));

-- Partial index: "show me the top-N churn risks" queries scan only
-- subscribers we've scored AND who are still enabled.
CREATE INDEX IF NOT EXISTS subscribers_churn_at_risk_idx
    ON subscribers (tenant_id, churn_score DESC, churn_score_at DESC)
    WHERE churn_score IS NOT NULL AND status = 'enabled';

-- Index supports the smart-unsubscribe page deciding "is this
-- subscriber currently paused?" without a sequential scan.
CREATE INDEX IF NOT EXISTS subscribers_paused_until_idx
    ON subscribers (tenant_id, paused_until)
    WHERE paused_until IS NOT NULL;

COMMIT;
