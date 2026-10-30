-- 0374_referral_payouts.sql
--
-- Desktop audit A10 — referral payout fulfilment rows.
--
-- One row per (referrer, milestone) pair the referrer has achieved.
-- Rows are written 'pending' by two producers:
--   1. The congrats worker (apps/api/internal/referrals/congrats_sender.go)
--      at the moment a conversion crosses a milestone boundary.
--   2. A derive-on-read backstop in GET /api/v1/referrals/payouts, which
--      recomputes achieved milestones from referral_conversions and inserts
--      any missing rows (covers tenants without the mailer-backed worker
--      and conversions that predate this table).
--
-- Operators move rows pending → approved → paid via
-- PATCH /api/v1/referrals/payouts/{id}.

BEGIN;

CREATE TABLE referral_payouts (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    referrer_subscriber_id text NOT NULL,
    milestone_count        int  NOT NULL CHECK (milestone_count > 0),
    reward_label           text NOT NULL DEFAULT '',
    status                 text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'paid')),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- A milestone is achieved at most once per referrer; the unique index is
-- what makes both producers idempotent (INSERT ... ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX referral_payouts_milestone_uniq
    ON referral_payouts (tenant_id, referrer_subscriber_id, milestone_count);

-- The operator checklist filters by status, newest first.
CREATE INDEX referral_payouts_tenant_status_idx
    ON referral_payouts (tenant_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_payouts TO postwave_app;

ALTER TABLE referral_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_payouts FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON referral_payouts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- RESTRICTIVE policies never grant rows on their own — pair with the
-- standard PERMISSIVE tenant policy (same pattern as 0079_remaining_rls_fixup).
CREATE POLICY tenant_visible ON referral_payouts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
