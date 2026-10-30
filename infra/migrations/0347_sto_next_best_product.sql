-- 0347_sto_next_best_product.sql
--
-- sto-next-best-product (P3, surface=send-time, effort=XL) — phase 2
-- scaffolding on top of migration 0315_next_best_product_recommender.sql.
--
-- Migration 0315 shipped the per-tenant recommender data model:
--   nbp_settings, nbp_item_similarity, nbp_user_affinity,
--   nbp_user_recent_bloom, nbp_recommendation_audit.
--
-- This migration adds the boilerplate the multi-week follow-up needs.
-- The accompanying Go package extension lives in
-- apps/api/internal/nbp/experiments.go and apps/api/internal/nbp/sidecar.go.
--
-- Tables added in this migration:
--
--  1. nbp_strategy_experiments(id, tenant_id, name, control_strategy,
--     variant_strategy, traffic_pct, status, ...)
--       Per-tenant A/B framework for recommender strategies. The
--       marketing team can toggle "Personalize vs item-item CF" or
--       "tighter similarity floor vs default" without code changes.
--       The recommender consults this table on render and routes the
--       subscriber to control / variant by a deterministic hash of
--       (subscriber_id, experiment_id) so the same subscriber always
--       gets the same arm across sends.
--
--  2. nbp_sidecar_endpoints(tenant_id, provider, endpoint_arn,
--     campaign_arn, status, ...)
--       Per-tenant configuration for vendor sidecar recommenders.
--       The first supported provider is AWS Personalize (matches
--       Mailchimp + MoEngage Smart Recommendations). The actual SDK
--       call sites live in the Go sidecar.go file — this row carries
--       the endpoint ARN, the campaign ARN, the IAM role to assume,
--       and a last-sync timestamp so the worker can decide when to
--       re-export the catalog.
--
--  3. nbp_campaign_performance(tenant_id, campaign_id,
--     impressions, clicks, conversions, revenue_cents, model_version,
--     strategy, generated_at)
--       Per-campaign aggregate of how a recommendation block actually
--       performed. Populated by a tracker that watches inbound click
--       + purchase events and joins back to nbp_recommendation_audit.
--       Drives the "Recommendation lift" widget on the dashboard.
--
-- All tables follow the canonical NULLIF GUC RLS idiom from 0079.
-- All FK references are unchanged from 0315 (tenants, subscribers,
-- commerce_products are presumed to exist).

BEGIN;

-- 1. Strategy experiments --------------------------------------------

CREATE TABLE IF NOT EXISTS nbp_strategy_experiments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Operator-facing label. Unique per tenant so the recommender can
    -- look up by name when an admin pins a specific experiment.
    name                text NOT NULL,
    -- The control arm. One of the canonical strategy strings the Go
    -- package already validates: item_item_cf | personalize | popularity.
    control_strategy    text NOT NULL DEFAULT 'item_item_cf'
        CHECK (control_strategy IN ('item_item_cf','personalize','popularity')),
    -- The variant arm.
    variant_strategy    text NOT NULL DEFAULT 'personalize'
        CHECK (variant_strategy IN ('item_item_cf','personalize','popularity')),
    -- Percentage of traffic (0-100) routed to the variant arm. The
    -- remainder goes to control. Hash-stable on (subscriber_id, id).
    traffic_pct         integer NOT NULL DEFAULT 50
        CHECK (traffic_pct BETWEEN 0 AND 100),
    -- draft | running | paused | concluded. The worker only consults
    -- rows with status='running'.
    status              text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','running','paused','concluded')),
    -- Optional per-experiment override of nbp_settings.top_n_per_user.
    -- Lets a tenant test "smaller block vs larger block".
    top_n_override      integer
        CHECK (top_n_override IS NULL OR top_n_override BETWEEN 1 AND 24),
    -- Notes the operator wants to attach (hypothesis, success metric).
    notes               text NOT NULL DEFAULT '',
    started_at          timestamptz,
    concluded_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS nbp_strategy_experiments_running_idx
    ON nbp_strategy_experiments (tenant_id, status)
    WHERE status = 'running';

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_strategy_experiments TO postwave_app;

ALTER TABLE nbp_strategy_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_strategy_experiments FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_strategy_experiments;
CREATE POLICY tenant_isolation ON nbp_strategy_experiments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_strategy_experiments;
CREATE POLICY tenant_visible ON nbp_strategy_experiments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Sidecar endpoints (Personalize, etc.) ----------------------------

CREATE TABLE IF NOT EXISTS nbp_sidecar_endpoints (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- 'personalize' is the only provider we explicitly scaffold for.
    -- Future providers: 'recombee', 'algolia_recommend'.
    provider            text NOT NULL DEFAULT 'personalize'
        CHECK (provider IN ('personalize','recombee','algolia_recommend')),
    -- Provider-specific resource identifier. For Personalize this is
    -- the campaign ARN ("arn:aws:personalize:...:campaign/...").
    endpoint_arn        text NOT NULL DEFAULT '',
    -- Optional dataset / catalog ARN used by the export job.
    dataset_arn         text NOT NULL DEFAULT '',
    -- IAM role the API server STS-assumes to call the sidecar. Empty
    -- means "fall back to the API's default execution role".
    iam_role_arn        text NOT NULL DEFAULT '',
    -- Region for the provider call. AWS-only providers ignore this for
    -- global SDKs but Personalize is per-region.
    region              text NOT NULL DEFAULT 'us-east-1',
    -- pending | active | error | disabled. The recommender only
    -- dispatches to a provider with status='active'.
    status              text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','active','error','disabled')),
    last_error          text NOT NULL DEFAULT '',
    last_synced_at      timestamptz,
    last_sync_item_count integer NOT NULL DEFAULT 0 CHECK (last_sync_item_count >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, provider)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_sidecar_endpoints TO postwave_app;

ALTER TABLE nbp_sidecar_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_sidecar_endpoints FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_sidecar_endpoints;
CREATE POLICY tenant_isolation ON nbp_sidecar_endpoints
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_sidecar_endpoints;
CREATE POLICY tenant_visible ON nbp_sidecar_endpoints
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Campaign-level recommendation performance ------------------------

CREATE TABLE IF NOT EXISTS nbp_campaign_performance (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The campaign whose recommendation block we are scoring. Not a
    -- hard FK because campaigns may be archived / deleted before we
    -- have a chance to aggregate the long-tail clicks.
    campaign_id        uuid NOT NULL,
    -- Which arm of the experiment, if any, produced this row. NULL for
    -- "not experimented" sends. The id matches nbp_strategy_experiments.id.
    experiment_id      uuid REFERENCES nbp_strategy_experiments(id) ON DELETE SET NULL,
    arm                text NOT NULL DEFAULT 'control'
        CHECK (arm IN ('control','variant')),
    -- The strategy that generated the recs in this row. Lets a
    -- non-experimental campaign still be sliced by strategy in the
    -- dashboard.
    strategy           text NOT NULL DEFAULT 'item_item_cf',
    impressions        bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
    clicks             bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
    conversions        bigint NOT NULL DEFAULT 0 CHECK (conversions >= 0),
    revenue_cents      bigint NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),
    -- The model_version that produced the recs — lets the dashboard
    -- contrast "v3 model" vs "v4 model" across the same audience.
    model_version      bigint NOT NULL DEFAULT 1,
    -- Last time the tracker walked nbp_recommendation_audit + the
    -- click + purchase event tables for this campaign.
    last_rolled_up_at  timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, campaign_id, arm, strategy)
);

CREATE INDEX IF NOT EXISTS nbp_campaign_performance_experiment_idx
    ON nbp_campaign_performance (tenant_id, experiment_id, arm)
    WHERE experiment_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_campaign_performance TO postwave_app;

ALTER TABLE nbp_campaign_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_campaign_performance FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_campaign_performance;
CREATE POLICY tenant_isolation ON nbp_campaign_performance
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_campaign_performance;
CREATE POLICY tenant_visible ON nbp_campaign_performance
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
