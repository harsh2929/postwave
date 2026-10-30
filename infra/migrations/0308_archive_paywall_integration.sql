-- 0302_archive_paywall_integration.sql
--
-- archive-paywall-integration (P1, surface=archive)
--
-- Postwave already ships the paywall package (paid_members, visibility
-- on campaigns, Stripe webhook ingestion) and a metered paywall on the
-- public archive — but archive issues had NO column to mark a specific
-- issue as members-only or to bind it to a named paid tier. Newsletters
-- running a "first X paragraphs free, rest paid" or a per-issue
-- "Founders-tier only" model couldn't gate.
--
-- This migration closes that gap:
--
--   1. `paywall_tiers` — named tiers per tenant (uuid-keyed). Replaces
--      the free-text `paid_members.tier` column with a proper lookup
--      so the publish slideover can pick a tier by name and the public
--      archive renderer can resolve "is this visitor in this tier?".
--      Backwards compatible: `paid_members.tier` (text) stays as a
--      legacy alias — the new `archive_paywall_tier_id` column on
--      campaigns is the canonical reference going forward.
--
--   2. `campaigns.archive_members_only` — boolean. When true, the
--      issue body is replaced with the excerpt + a paywall CTA for
--      non-members. Defaults to false so existing rows stay public.
--
--   3. `campaigns.archive_paywall_tier_id` — uuid → paywall_tiers.id.
--      When set, the gate requires the visitor to be in THIS specific
--      tier. When NULL but archive_members_only=true, ANY paid_members
--      row with status='active'|'past_due' passes (legacy "all paid
--      members" behaviour).
--
-- Inspired by 2026 SOTA: beehiiv (per-post premium toggle + tier
-- targeting), Substack (Founders-tier per-post gating), Ghost (post
-- visibility=members|paid|tier:slug), Buttondown (paid email gate).
--
-- RLS: paywall_tiers gets the canonical tenant-RLS pair (RESTRICTIVE +
-- PERMISSIVE) using the `NULLIF(current_setting('app.tenant_id',
-- true), '')::uuid` idiom (raw cast crashes when the GUC is unset, so
-- we always go through NULLIF).

BEGIN;

-- 1. paywall_tiers — per-tenant named tier registry.
CREATE TABLE IF NOT EXISTS paywall_tiers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Operator-visible name ("Founders", "Pro", "Annual"). Unique per
    -- tenant so the publish slideover can render a clean picker.
    name        TEXT NOT NULL,
    -- Stripe price id this tier is sold under, when applicable.
    -- Optional so a tenant can run a manually-granted tier without
    -- Stripe (e.g. employee comp tier).
    stripe_price_id TEXT,
    -- Free-text descriptor surfaced beneath the tier name in the
    -- picker. Kept short — the slideover renders 1-2 lines.
    description TEXT,
    -- Soft-delete: we never hard-delete a tier because campaigns may
    -- reference it. Setting `active=false` hides it from the picker
    -- but preserves the historical binding so re-renders of old issues
    -- still resolve.
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS paywall_tiers_tenant_active_idx
    ON paywall_tiers (tenant_id, active)
    WHERE active = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON paywall_tiers TO postwave_app;

-- Deferred FK from retention_offers (created in 0306, before this table
-- existed). Now that paywall_tiers exists, wire the referential integrity
-- the 0306 column declared. Guarded so a re-run is a no-op.
DO $$
BEGIN
    IF to_regclass('public.retention_offers') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'retention_offers_paywall_tier_id_fkey'
       ) THEN
        ALTER TABLE retention_offers
            ADD CONSTRAINT retention_offers_paywall_tier_id_fkey
            FOREIGN KEY (paywall_tier_id) REFERENCES paywall_tiers(id) ON DELETE CASCADE;
    END IF;
END
$$;

ALTER TABLE paywall_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE paywall_tiers FORCE  ROW LEVEL SECURITY;

-- RESTRICTIVE + PERMISSIVE pair mirroring the schema-wide standard
-- from 0079. NULLIF guards against unset GUC crashing the cast.
CREATE POLICY tenant_isolation ON paywall_tiers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON paywall_tiers
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. campaigns: archive_members_only + archive_paywall_tier_id.
--
-- `IF NOT EXISTS` lets the migration be re-run idempotently in dev
-- without blowing up on partial state.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS archive_members_only    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS archive_paywall_tier_id UUID;

-- FK is added separately so the column add can succeed on tables that
-- already have the columns (idempotent re-run). ON DELETE SET NULL so
-- deleting a tier doesn't cascade-delete published issues — instead the
-- issue degrades to "any paid member" gating.
DO $$ BEGIN
    ALTER TABLE campaigns
        ADD CONSTRAINT campaigns_archive_paywall_tier_fk
        FOREIGN KEY (archive_paywall_tier_id)
        REFERENCES paywall_tiers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Partial index so the public archive renderer's "is this gated?" check
-- stays cheap on tenants with thousands of issues. Only indexes the
-- gated rows.
CREATE INDEX IF NOT EXISTS campaigns_archive_members_only_idx
    ON campaigns (tenant_id, archive_members_only)
    WHERE archive_public = true AND archive_members_only = true;

COMMIT;
