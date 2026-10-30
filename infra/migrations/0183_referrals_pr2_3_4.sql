-- 0183_referrals_pr2_3_4.sql
--
-- Refined Referrals PRs 2 + 3 + 4 (single migration bundle, since
-- they all ship in one batch):
--
-- PR 2 — merge tags + reward art
--   • reward_image_asset_id lives inside milestones_v2 jsonb (no
--     schema change needed — jsonb is flexible).
--
-- PR 3 — branded codes + fraud + auto-congrats
--   • referral_codes.desired_code: lets users mint a memorable code
--     (acme-bestie vs xa9k2m). Globally unique when set.
--   • referral_conversions.referee_ip:    used by fraud heuristics
--   • referral_conversions.fraud_score:   0..1, written on credit
--   • referral_conversions.congrats_sent_at: idempotency for the
--     auto-congrats sender so a milestone never fires twice.
--
-- PR 4 — timeline programs + payout tracking + embed
--   • referral_programs.expires_at: optional end date; subscriber
--     view filters out expired programs.
--   • referral_conversions.payout_status: pending|sent|delivered
--     for the fulfilment checklist UI.
--   • referral_conversions.payout_note: free-text operator note.
--
-- (Widget endpoint is read-only — no table.)

BEGIN;

-- PR 3: branded codes
ALTER TABLE referral_codes
    ADD COLUMN desired_code text;

CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_desired_code_uniq
    ON referral_codes (desired_code) WHERE desired_code IS NOT NULL;

-- PR 3: fraud + congrats
ALTER TABLE referral_conversions
    ADD COLUMN referee_ip       text,
    ADD COLUMN fraud_score      double precision NOT NULL DEFAULT 0,
    ADD COLUMN congrats_sent_at timestamptz;

-- PR 4: timeline + payout
ALTER TABLE referral_programs
    ADD COLUMN expires_at timestamptz;

ALTER TABLE referral_conversions
    ADD COLUMN payout_status text NOT NULL DEFAULT 'pending'
        CHECK (payout_status IN ('pending', 'sent', 'delivered', 'skipped')),
    ADD COLUMN payout_note   text;

CREATE INDEX IF NOT EXISTS referral_conversions_payout_idx
    ON referral_conversions (tenant_id, payout_status, created_at DESC);

COMMIT;
