-- 0054_paywall.sql
--
-- Member-only paid-content paywall, opt-in per campaign.
--
-- Context: many newsletter creators run a "free + paid" tier model. A
-- post is published to everyone, but only paid members see the full
-- text — free readers see a teaser with a paywall CTA.
--
-- We don't take payments here; that's Stripe Connect's job. We track
-- which (tenant, subscriber_email) pairs are paid so the public
-- archive renderer can decide what to show. Status values mirror
-- common Stripe subscription states so we can sync with one column.

BEGIN;

-- Per-campaign visibility flag. NULL legacy = public.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS visibility text
    CHECK (visibility IS NULL OR visibility IN ('public', 'members', 'paid'));
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS paywall_teaser_chars int
    CHECK (paywall_teaser_chars IS NULL OR (paywall_teaser_chars >= 100 AND paywall_teaser_chars <= 5000));

-- One row per (tenant, subscriber_email) recognized as a paid member.
-- Producers: Stripe Connect webhooks (subscription.created /
-- updated / canceled) when subscription mode = paid_membership.
-- Free tier "members" don't go in this table — they're just any
-- existing subscriber with consent_status = 'subscribed'.
CREATE TABLE paid_members (
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email citext NOT NULL,
    -- 'active' | 'past_due' | 'canceled' | 'paused'. Mirrors Stripe.
    status           text NOT NULL DEFAULT 'active',
    stripe_subscription_id text,
    -- Tier name; lets a tenant run multiple paid tiers ("Pro", "Founders").
    tier             text,
    started_at       timestamptz NOT NULL DEFAULT now(),
    cancelled_at     timestamptz,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_id, subscriber_email)
);

CREATE INDEX paid_members_status_idx
    ON paid_members (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON paid_members TO postwave_app;

ALTER TABLE paid_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE paid_members FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON paid_members
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
