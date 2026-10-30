-- 0297_next_best_product_recommender.sql
--
-- sto-next-best-product (P3, surface=send-time, effort=XL)
--
-- Per-user product recommendations. Klaviyo's "Next Best Product" uses
-- item-item collaborative filtering with a Bloom filter to exclude
-- products the subscriber has bought in the last 2 years. Mailchimp's
-- "Personalized Product Recommendations" and MoEngage's "Smart
-- Recommendations" run on AWS Personalize. This migration ships the
-- self-hosted data model — a stubbed-out item-item recommender with
-- room for a Personalize sidecar later.
--
-- Tables:
--
--  1. nbp_settings(tenant_id, enabled, recency_exclude_days,
--     top_n_per_user, similarity_floor, refresher_strategy, ...)
--       Per-tenant on/off + the levers operators tune from
--       Settings > Personalization > Recommendations.
--
--  2. nbp_item_similarity(tenant_id, anchor_product_id,
--     neighbor_product_id, similarity, support, model_version,
--     computed_at)
--       Top-K item-item cosine similarities. Computed offline by the
--       nightly nbp.Builder worker over commerce_order_items
--       co-occurrence (each order = one "basket"). The Builder bounds
--       K per anchor so the table stays linear in catalog size, not
--       quadratic. `support` is the co-occurrence count (the
--       denominator behind the cosine score) — surfaced so the
--       compose-time preview can show "12 baskets back this" instead
--       of an opaque 0.83 number.
--
--  3. nbp_user_affinity(tenant_id, subscriber_id, product_id, score,
--     last_purchased_at, purchase_count, computed_at)
--       Per-subscriber/per-product affinity, materialized from
--       historical orders. The recommender pulls the top-N anchors
--       per subscriber and walks nbp_item_similarity to expand into
--       candidate recommendations. Recomputed nightly by the same
--       Builder.
--
--  4. nbp_user_recent_bloom(tenant_id, subscriber_id, bloom_bits,
--     bloom_k, bloom_m, item_count, window_days, refreshed_at)
--       Compact Bloom filter of products the subscriber has bought in
--       the last `window_days` (default 730 = 2y, matching Klaviyo).
--       Stored as bytea so the recommender can load it without
--       fetching every line item from commerce_order_items at
--       render time. False-positive rate target ~1% with k=4 hashes
--       and m bits sized at runtime.
--
--  5. nbp_recommendation_audit(tenant_id, subscriber_id, campaign_id,
--     product_ids, model_version, generated_at)
--       Append-only ledger of which products we recommended to whom,
--       so the marketing team can answer "why did Alice get product
--       42 in the May newsletter?" Retention: 90 days (matches the
--       existing campaign_send_log policy).
--
-- All tables follow the canonical NULLIF GUC RLS idiom from 0079.
-- Bloom filter math: with 1% target FPR, k=4 hashes, m ≈ 9.6 * n bits
-- where n = item count in window. Bytes column sized to handle up to
-- 50k items (~60KB/row) which covers a 99th-percentile Shopify
-- shopper.

BEGIN;

-- 1. Settings ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS nbp_settings (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled                boolean NOT NULL DEFAULT false,
    -- How far back to dedupe purchases ("don't recommend a product
    -- they bought in the last N days"). Klaviyo defaults to 730d (2y).
    recency_exclude_days   integer NOT NULL DEFAULT 730
        CHECK (recency_exclude_days BETWEEN 0 AND 3650),
    -- Top-N items to surface per render. Bounded at 24 so the email
    -- template never grows to absurd sizes.
    top_n_per_user         integer NOT NULL DEFAULT 6
        CHECK (top_n_per_user BETWEEN 1 AND 24),
    -- Floor on item-item cosine similarity. Below this we treat
    -- co-occurrence as noise and fall back to popularity.
    similarity_floor       numeric(4,3) NOT NULL DEFAULT 0.050
        CHECK (similarity_floor >= 0 AND similarity_floor <= 1),
    -- 'item_item_cf' = self-hosted cosine recommender (the only
    -- strategy this migration ships). 'personalize' = AWS Personalize
    -- sidecar (deferred; the column exists so the settings UI can
    -- show the option as disabled). 'popularity' = popularity-only
    -- fallback for new tenants with no order history.
    refresher_strategy     text NOT NULL DEFAULT 'item_item_cf'
        CHECK (refresher_strategy IN ('item_item_cf','personalize','popularity')),
    -- How fresh the similarity table should be. The nightly Builder
    -- skips tenants whose similarity_computed_at is within
    -- refresh_interval_hours of now.
    refresh_interval_hours integer NOT NULL DEFAULT 24
        CHECK (refresh_interval_hours BETWEEN 1 AND 168),
    -- Bloom filter target false-positive rate (FPR). 1% is the Klaviyo
    -- default; tenants can tighten to 0.1% at the cost of ~50% more
    -- bloom_bits storage per row.
    bloom_target_fpr       numeric(4,4) NOT NULL DEFAULT 0.0100
        CHECK (bloom_target_fpr > 0 AND bloom_target_fpr < 0.5),
    -- Most recent Builder run timestamp + model version. The nightly
    -- worker bumps these atomically when it finishes a tenant.
    similarity_computed_at timestamptz,
    affinity_computed_at   timestamptz,
    model_version          bigint NOT NULL DEFAULT 1,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_settings TO postwave_app;

ALTER TABLE nbp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_settings;
CREATE POLICY tenant_isolation ON nbp_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_settings;
CREATE POLICY tenant_visible ON nbp_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Item-item similarity --------------------------------------------

CREATE TABLE IF NOT EXISTS nbp_item_similarity (
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    anchor_product_id    uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    neighbor_product_id  uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    similarity           numeric(5,4) NOT NULL
        CHECK (similarity >= 0 AND similarity <= 1),
    -- Number of orders in which both products co-occurred. The cosine
    -- denominator. Surfaced so previews can show confidence.
    support              integer NOT NULL DEFAULT 0
        CHECK (support >= 0),
    model_version        bigint NOT NULL DEFAULT 1,
    computed_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, anchor_product_id, neighbor_product_id),
    -- Guard against the degenerate self-pair (a product is trivially
    -- similar to itself; the recommender skips these but the table
    -- shouldn't even let them in).
    CHECK (anchor_product_id <> neighbor_product_id)
);

-- For the "give me top-K neighbors of product X" hot path.
CREATE INDEX IF NOT EXISTS nbp_item_similarity_anchor_idx
    ON nbp_item_similarity (tenant_id, anchor_product_id, similarity DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_item_similarity TO postwave_app;

ALTER TABLE nbp_item_similarity ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_item_similarity FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_item_similarity;
CREATE POLICY tenant_isolation ON nbp_item_similarity
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_item_similarity;
CREATE POLICY tenant_visible ON nbp_item_similarity
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Per-user affinity -----------------------------------------------

CREATE TABLE IF NOT EXISTS nbp_user_affinity (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id      uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    product_id         uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    -- Affinity in [0, 1] — purchase_count weighted by recency decay.
    score              numeric(5,4) NOT NULL DEFAULT 0
        CHECK (score >= 0 AND score <= 1),
    last_purchased_at  timestamptz,
    purchase_count     integer NOT NULL DEFAULT 0 CHECK (purchase_count >= 0),
    computed_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id, product_id)
);

CREATE INDEX IF NOT EXISTS nbp_user_affinity_subscriber_idx
    ON nbp_user_affinity (tenant_id, subscriber_id, score DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_user_affinity TO postwave_app;

ALTER TABLE nbp_user_affinity ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_user_affinity FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_user_affinity;
CREATE POLICY tenant_isolation ON nbp_user_affinity
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_user_affinity;
CREATE POLICY tenant_visible ON nbp_user_affinity
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 4. Recent-purchase Bloom filter ------------------------------------

CREATE TABLE IF NOT EXISTS nbp_user_recent_bloom (
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id  uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- Packed bit array. Sized at refresh time as ceil(-n*ln(p)/ln(2)^2 / 8)
    -- bytes, where n = item_count and p = bloom_target_fpr.
    bloom_bits     bytea NOT NULL,
    bloom_k        integer NOT NULL DEFAULT 4 CHECK (bloom_k BETWEEN 1 AND 16),
    -- Total bit width m. Stored explicitly so the reader doesn't need
    -- to rederive it from len(bloom_bits)*8 (which would round up).
    bloom_m        integer NOT NULL CHECK (bloom_m > 0),
    item_count     integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    window_days    integer NOT NULL DEFAULT 730 CHECK (window_days >= 0),
    refreshed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_user_recent_bloom TO postwave_app;

ALTER TABLE nbp_user_recent_bloom ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_user_recent_bloom FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_user_recent_bloom;
CREATE POLICY tenant_isolation ON nbp_user_recent_bloom
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_user_recent_bloom;
CREATE POLICY tenant_visible ON nbp_user_recent_bloom
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 5. Recommendation audit ledger -------------------------------------

CREATE TABLE IF NOT EXISTS nbp_recommendation_audit (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    -- Nullable because transactional sends use the same recommender but
    -- aren't bound to a campaign row.
    campaign_id     uuid,
    -- Ordered list of product UUIDs we returned. Top-N, so worst case 24
    -- entries — fits easily in a jsonb column.
    product_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The model_version (from nbp_settings) at generation time. A bump
    -- here lets the marketing team A/B between model revisions.
    model_version   bigint NOT NULL DEFAULT 1,
    -- 'item_item_cf' | 'personalize' | 'popularity' | 'cold_start_fallback'
    strategy        text NOT NULL DEFAULT 'item_item_cf',
    generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nbp_recommendation_audit_tenant_subscriber_idx
    ON nbp_recommendation_audit (tenant_id, subscriber_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS nbp_recommendation_audit_tenant_campaign_idx
    ON nbp_recommendation_audit (tenant_id, campaign_id, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON nbp_recommendation_audit TO postwave_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE nbp_recommendation_audit_id_seq TO postwave_app;

ALTER TABLE nbp_recommendation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nbp_recommendation_audit FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON nbp_recommendation_audit;
CREATE POLICY tenant_isolation ON nbp_recommendation_audit
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON nbp_recommendation_audit;
CREATE POLICY tenant_visible ON nbp_recommendation_audit
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
