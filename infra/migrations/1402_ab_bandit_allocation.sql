-- 1402_ab_bandit_allocation.sql
--
-- G4 (campaigns 2026): multi-armed bandit A/B allocation. The existing
-- A/B path splits the audience by a fixed campaign_variants.weight. This
-- adds a bandit strategy that periodically recomputes those weights from
-- each variant's open/click posterior, so the winning arm gets more of
-- the remaining audience automatically. Because AssignVariant already
-- buckets by campaign_variants.weight, recomputing that column IS the
-- re-bucketing — no change to the sampling/dispatch path.

BEGIN;

ALTER TABLE campaign_ab_settings
    ADD COLUMN IF NOT EXISTS bandit_strategy           text NOT NULL DEFAULT 'fixed',
    ADD COLUMN IF NOT EXISTS explore_floor             numeric(4,3) NOT NULL DEFAULT 0.100,
    ADD COLUMN IF NOT EXISTS recompute_interval_minutes integer NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS last_recomputed_at        timestamptz;

DO $$ BEGIN
    ALTER TABLE campaign_ab_settings
        ADD CONSTRAINT campaign_ab_settings_bandit_strategy_chk
        CHECK (bandit_strategy IN ('fixed', 'thompson', 'epsilon_greedy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Allocation-drift history: one row per (campaign, variant) per recompute
-- so the A/B Results modal can chart how the bandit shifted weight over
-- the send.
CREATE TABLE IF NOT EXISTS campaign_variant_weight_history (
    id           bigserial   PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id  uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    variant_id   uuid        NOT NULL,
    weight       numeric(5,2) NOT NULL,
    recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_variant_weight_history_idx
    ON campaign_variant_weight_history (tenant_id, campaign_id, recorded_at);

GRANT SELECT, INSERT, DELETE ON campaign_variant_weight_history TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_variant_weight_history_id_seq TO postwave_app;

ALTER TABLE campaign_variant_weight_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_variant_weight_history FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_variant_weight_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_variant_weight_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
