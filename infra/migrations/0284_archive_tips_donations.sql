-- 0284_archive_tips_donations.sql
--
-- Gap feature `archive-tips-donations` (P3, surface=archive).
-- Inspired by Ghost's "Tips & Donations" — a per-publication
-- configurable Stripe Checkout tip jar that lets readers send a one-off
-- payment from any public archive issue. Members and non-members can
-- pay; the platform takes 0% on top of Stripe's processing fee
-- (parity with Ghost's positioning).
--
-- Two surface areas:
--
--   1. Per-tenant config columns on `tenant_public_settings`:
--        - tips_enabled            (boolean, default false)
--        - tips_currency           (text iso-4217, default 'usd')
--        - tips_suggested_amounts  (int[] of MINOR units — cents).
--          The frontend renders one quick-pick button per array entry;
--          an empty array hides the picker and renders a single
--          custom-amount input.
--        - tips_min_amount         (int — minor units, default 100 = $1.00).
--          Hard floor so a typo doesn't create a $0.01 Stripe Checkout
--          session (which Stripe rejects with `amount_too_small`
--          anyway, but we want a clean 400 not a 502).
--        - tips_message            (text, optional). The short blurb
--          rendered above the tip-amount picker
--          (e.g. "Enjoying the newsletter? Tip the author.").
--
--   2. New `archive_tips` event log so the dashboard can show "Tips
--      this month" + the admin Slack notification handler has a row
--      to read on each Stripe webhook fan-out.
--
-- All new columns are nullable / defaulted so existing rows continue
-- to work; the public archive page falls back to "tips off" when
-- tips_enabled is NULL or false.
--
-- RLS — `archive_tips` follows the tenant-isolation idiom used
-- everywhere else: PRIMARY KEY (tenant_id, id), forced RLS, restrictive
-- policy reading `app.tenant_id` via NULLIF(current_setting(..., true),
-- '')::uuid so an unset GUC returns zero rows instead of crashing.
-- A PERMISSIVE policy lets the unauthenticated webhook path INSERT a
-- new row even though the GUC is unset; the row carries
-- `stripe_session_id` which is a Stripe-issued ULID, not guessable.

BEGIN;

ALTER TABLE tenant_public_settings
    ADD COLUMN IF NOT EXISTS tips_enabled           boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS tips_currency          text    NOT NULL DEFAULT 'usd',
    ADD COLUMN IF NOT EXISTS tips_suggested_amounts integer[] NOT NULL DEFAULT '{300,500,1000,2500}'::integer[],
    ADD COLUMN IF NOT EXISTS tips_min_amount        integer NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS tips_message           text;

-- Defensive checks — keep bad operator input out of the column.
DO $$
BEGIN
    -- 3-letter ISO 4217 lowercase currency code.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tenant_public_settings_tips_currency_shape'
    ) THEN
        ALTER TABLE tenant_public_settings
            ADD CONSTRAINT tenant_public_settings_tips_currency_shape
            CHECK (tips_currency ~ '^[a-z]{3}$');
    END IF;
    -- Minor-unit floor so a "$0.00" tip is rejected at the DB layer.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tenant_public_settings_tips_min_amount_ge_50'
    ) THEN
        ALTER TABLE tenant_public_settings
            ADD CONSTRAINT tenant_public_settings_tips_min_amount_ge_50
            CHECK (tips_min_amount >= 50);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS archive_tips (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    -- Optional — when the tip was triggered from an issue page, we
    -- record the campaign id so the per-issue dashboard can roll up
    -- "Tips earned on this issue". Tips from the archive index page
    -- (no current issue context) leave this NULL.
    campaign_id        uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    -- Stripe ids. session_id is unique per-tip; payment_intent fills
    -- in once the webhook fires (NULL during the brief window between
    -- session create and checkout completion).
    stripe_session_id  text NOT NULL,
    stripe_payment_id  text,
    -- Amount as Stripe billed it — minor units + ISO 4217 currency.
    amount_minor       integer NOT NULL,
    currency           text NOT NULL,
    -- Status enum: 'pending' on session-create; 'succeeded' on
    -- checkout.session.completed; 'refunded' on charge.refunded;
    -- 'failed' on payment_failed. Keeps the dashboard query simple
    -- ("SELECT amount WHERE status='succeeded'") and lets the admin
    -- panel show pending sessions for debugging.
    status             text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','succeeded','refunded','failed')),
    -- Best-effort supporter metadata captured from the Stripe session.
    -- Both columns are nullable: anonymous tips (no email collected,
    -- no name typed in the optional field) leave them NULL.
    supporter_email    text,
    supporter_name     text,
    -- Optional free-text "note from the supporter" — surfaced on the
    -- admin notification + future "wall of supporters" feature.
    message            text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (stripe_session_id)
);

CREATE INDEX IF NOT EXISTS archive_tips_tenant_created_idx
    ON archive_tips (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS archive_tips_campaign_idx
    ON archive_tips (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON archive_tips TO postwave_app;

ALTER TABLE archive_tips ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_tips FORCE  ROW LEVEL SECURITY;

-- Restrictive tenant-isolation: every read/write from the
-- admin/dashboard surface must have `app.tenant_id` set.
CREATE POLICY archive_tips_tenant_isolation ON archive_tips
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive INSERT/UPDATE for the public-checkout + webhook paths
-- that run without a tenant GUC (the row carries tenant_id explicitly
-- via the request body, validated against tenant_public_settings).
CREATE POLICY archive_tips_public_writer ON archive_tips
    AS PERMISSIVE FOR INSERT
    WITH CHECK (true);

CREATE POLICY archive_tips_webhook_updater ON archive_tips
    AS PERMISSIVE FOR UPDATE
    USING (true)
    WITH CHECK (true);

COMMIT;
