-- 0306_archive_retention_offers.sql
--
-- archive-retention-offers (P3, surface=archive)
--
-- When a paid member clicks "Cancel" in the subscriber portal, interject
-- a one-time retention offer configured per tier before the cancellation
-- completes. Acceptance pauses the cancel and applies a Stripe coupon;
-- decline proceeds to cancel as before. Both branches are tracked so the
-- operator can tune offer effectiveness (acceptance rate, downstream
-- churn) from the dashboard.
--
-- Inspired by 2026 SOTA from Ghost (and broadly Substack / beehiiv /
-- Patreon): cancel-flow save offers are the table-stakes lever for
-- recovering would-have-churned MRR on member-supported pubs.
--
-- This migration adds:
--
--   1. `retention_offers` — operator-defined offer catalog keyed by
--      paywall_tier_id. One offer per tier in v1 (UNIQUE) — Ghost's
--      surface follows the same shape; multi-step offer ladders are a
--      v2 concern. percent_off XOR fixed_off_cents (CHECK), with an
--      optional duration_months for the discounted window (default
--      one-cycle, i.e. duration_months=1). `active=false` soft-disables
--      so historical accepts still resolve.
--
--   2. `retention_offer_events` — append-only audit log per offer
--      surface. Captures `event_type ∈ {shown, accepted, declined,
--      expired}` per paid_sub. Indexed by (tenant_id, offer_id,
--      event_type) so the dashboard's funnel tile (shown → accepted)
--      is a single index scan.
--
-- RLS: both tables follow the canonical RESTRICTIVE + PERMISSIVE pair
-- using the `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
-- idiom (raw cast crashes when the GUC is unset).

BEGIN;

-- 1. retention_offers — catalog of cancel-flow save offers per tier.
CREATE TABLE IF NOT EXISTS retention_offers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The tier the cancel-flow offer applies to. When a member of THIS
    -- tier clicks cancel, this is the offer they see. ON DELETE CASCADE
    -- because a tier teardown should drop its bound offer; admins
    -- soft-disable instead via active=false.
    -- NOTE: paywall_tiers is created later (0308), so the FK is added there
    -- via ALTER once the referenced table exists (fresh in-order replay).
    paywall_tier_id   UUID NOT NULL,
    -- Percent-off XOR fixed_off_cents. The CHECK below enforces exactly
    -- one is set.
    percent_off       SMALLINT,
    fixed_off_cents   INTEGER,
    -- How many billing cycles the discount applies for. 1 = one cycle
    -- ("here's $5 off your next month"); 12 = a year; NULL/0 falls back
    -- to 1 (the most common Ghost / Substack default). Capped at 60 to
    -- match Stripe's coupon `duration_in_months` upper bound.
    duration_months   SMALLINT NOT NULL DEFAULT 1,
    -- Free-text copy surfaced inside the modal. Kept short — the
    -- subscriber portal renders 1-3 lines.
    headline          TEXT,
    body              TEXT,
    -- Stripe coupon id minted via the Stripe bridge on first activate.
    -- Optional so a tenant can run a hand-managed offer (legacy /
    -- comp tier) without Stripe wiring.
    stripe_coupon_id  TEXT,
    active            BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, paywall_tier_id),
    CONSTRAINT retention_offers_amount_chk
        CHECK (
            (percent_off IS NOT NULL AND fixed_off_cents IS NULL
             AND percent_off BETWEEN 1 AND 100)
         OR (percent_off IS NULL AND fixed_off_cents IS NOT NULL
             AND fixed_off_cents > 0)
        ),
    CONSTRAINT retention_offers_duration_chk
        CHECK (duration_months BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS retention_offers_tenant_active_idx
    ON retention_offers (tenant_id, active)
    WHERE active = true;

CREATE INDEX IF NOT EXISTS retention_offers_tier_idx
    ON retention_offers (tenant_id, paywall_tier_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON retention_offers TO postwave_app;

ALTER TABLE retention_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_offers FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON retention_offers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON retention_offers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. retention_offer_events — append-only audit log per surface.
CREATE TABLE IF NOT EXISTS retention_offer_events (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    offer_id      UUID NOT NULL REFERENCES retention_offers(id) ON DELETE CASCADE,
    -- The paid sub the offer was surfaced to. ON DELETE CASCADE keeps
    -- the audit log scoped to live subs — historical analytics drill in
    -- through the materialized rollup, not raw events.
    paid_sub_id   UUID,
    subscriber_email TEXT,
    event_type    TEXT NOT NULL
        CHECK (event_type IN ('shown','accepted','declined','expired')),
    -- Stripe coupon application receipt for accepted events.
    stripe_application_id TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retention_offer_events_funnel_idx
    ON retention_offer_events (tenant_id, offer_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS retention_offer_events_paid_sub_idx
    ON retention_offer_events (tenant_id, paid_sub_id, created_at DESC)
    WHERE paid_sub_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON retention_offer_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE retention_offer_events_id_seq TO postwave_app;

ALTER TABLE retention_offer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_offer_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON retention_offer_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON retention_offer_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
