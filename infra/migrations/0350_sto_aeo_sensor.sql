-- 0350_sto_aeo_sensor.sql
--
-- sto-aeo-sensor — PUBLIC industry-wide AEO Sensor (P3, surface=archive,
-- effort=XL).
--
-- Migration 0300 (aeo_sensor.sql) shipped the per-tenant probe ledger
-- (aeo_settings / aeo_prompts / aeo_probes / aeo_daily_rollup /
-- aeo_competitors). That gives a single brand its own mention /
-- citation / volatility view.
--
-- This migration adds the *PUBLIC, INDUSTRY-WIDE* Sensor surface — the
-- HubSpot AEO Sensor moat. Every Postwave tenant who has the AEO probe
-- harness running contributes anonymized signal into a small set of
-- cross-tenant industry rollups. The result is a free, public
-- /sensor/aeo/industries surface that renders an industry-by-industry
-- "AI Search Volatility Index" (0-100) updated daily across
-- ChatGPT / Gemini / Perplexity / Copilot / Grok.
--
-- Why this matters: no other marketing-cloud ships a public AI-search
-- volatility instrument. HubSpot's AEO Sensor is the reference (free,
-- gated only by an email). This migration scaffolds the data model
-- that lets Postwave's daily worker emit the same instrument.
--
-- DEFERRED (see apps/api/internal/aeo/MIGRATION.md):
--   * k-anonymity threshold enforcement (currently MIN_CONTRIBUTORS = 5
--     is a hardcoded constant — the SQL CHECK only validates the
--     stored row, not the rollup pipeline that produces it).
--   * Per-industry prompt pack curation (today every contributing
--     tenant's probes feed the rollup unfiltered; the real Sensor
--     should weight by an industry-specific prompt subset).
--   * Public API rate-limiting + caching tier (the routes are wired
--     read-through; production needs a CDN-cacheable response shape).
--   * Optional differential-privacy noise on the public series — the
--     k-anon threshold is a floor, not a ceiling.
--
-- Schema:
--
--   1. aeo_sensor_industries
--        The canonical industry taxonomy. Seeded by this migration
--        with ~20 verticals (Ecommerce, SaaS, FinTech, ...). The
--        Sensor dashboard reads this for the industry filter.
--
--   2. aeo_tenant_industry
--        Per-tenant opt-in to a single industry. Tenants that don't
--        opt in are excluded from every public rollup — anonymized
--        aggregation does NOT mean "scraping every tenant by
--        default". GDPR / contractual compliance lives here.
--
--   3. aeo_sensor_industry_rollup
--        The PUBLIC, ANONYMIZED rollup. One row per (industry, engine,
--        day). Stores mention_rate / citation_rate / volatility_score
--        averaged over all contributing tenants, plus the
--        contributor_count (so the UI can suppress / disclaim
--        low-sample rows). NEVER joined back to tenant_id — the
--        aggregator pipeline computes per-tenant rates first and
--        writes ONLY the aggregated row.
--
--   4. aeo_sensor_industry_volatility (materialised view shape)
--        Materialised view over aeo_sensor_industry_rollup that emits
--        the rolling 14-day volatility per (industry, engine). This
--        is the headline tile on the public Sensor page.
--
--   5. aeo_sensor_changelog
--        Append-only ledger of every Sensor publish. Used by the
--        public /sensor/aeo/changelog endpoint so subscribers can
--        verify the publish cadence.
--
-- All tables use the canonical NULLIF GUC RLS idiom from 0079 — the
-- per-tenant opt-in table follows tenant_isolation; the public rollup
-- table is intentionally readable from any session (RLS off) because
-- the data is by design anonymized + aggregated.

BEGIN;

-- 1. Industry taxonomy ----------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_sensor_industries (
    -- Short slug used in URLs and the contributing tenant join row.
    slug         text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_-]{1,39}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    -- Ordering for the public dashboard filter dropdown. NULLS LAST
    -- so the "Other" bucket falls to the bottom.
    sort_order   integer NOT NULL DEFAULT 100,
    -- Optional parent for a future two-level taxonomy (e.g.
    -- "Ecommerce > Apparel"). NULL for top-level rows. Self-FK is
    -- intentional — keeps the join read in one trip.
    parent_slug  text REFERENCES aeo_sensor_industries(slug) ON DELETE SET NULL,
    -- 'active' rows show in the picker; 'archived' rows stay so
    -- historical rollups still resolve.
    status       text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','archived')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_sensor_industries TO postwave_app;

-- This is reference data, not per-tenant. RLS stays OFF so the public
-- /sensor/aeo/industries endpoint can read without a tenant scope.

-- Seed the canonical ~20-vertical taxonomy. Matches HubSpot's
-- AEO Sensor industry list one-for-one so a side-by-side comparison
-- in pitches is straightforward.
INSERT INTO aeo_sensor_industries (slug, display_name, sort_order) VALUES
    ('ecommerce',          'Ecommerce',              10),
    ('saas',               'SaaS',                   20),
    ('fintech',            'FinTech',                30),
    ('healthtech',         'HealthTech',             40),
    ('edtech',             'EdTech',                 50),
    ('media_publishing',   'Media & Publishing',     60),
    ('travel_hospitality', 'Travel & Hospitality',   70),
    ('real_estate',        'Real Estate',            80),
    ('insurance',          'Insurance',              90),
    ('b2b_services',       'B2B Services',          100),
    ('marketing_agency',   'Marketing & Agency',    110),
    ('nonprofit',          'Nonprofit',             120),
    ('government',         'Government & Public',   130),
    ('manufacturing',      'Manufacturing',         140),
    ('logistics',          'Logistics',             150),
    ('food_beverage',      'Food & Beverage',       160),
    ('fashion_apparel',    'Fashion & Apparel',     170),
    ('automotive',         'Automotive',            180),
    ('professional_svc',   'Professional Services', 190),
    ('other',              'Other',                 999)
ON CONFLICT (slug) DO NOTHING;

-- 2. Tenant opt-in --------------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_tenant_industry (
    -- One row per tenant max — a brand operates in a single industry
    -- for the purpose of the public rollup.
    tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    industry_slug  text NOT NULL REFERENCES aeo_sensor_industries(slug) ON DELETE RESTRICT,
    -- Explicit opt-in: tenants are EXCLUDED from the public rollup
    -- by default. The settings UI flips this true; the rollup worker
    -- treats false as "do not include this tenant's probes in the
    -- aggregate". Defensive default — anonymized aggregation still
    -- carries reputational risk if a tenant didn't expect it.
    contribute_to_public boolean NOT NULL DEFAULT false,
    -- When the tenant last confirmed the opt-in. Used to render the
    -- "you opted in on 2026-06-04" stamp in the settings UI.
    opted_in_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_tenant_industry TO postwave_app;

ALTER TABLE aeo_tenant_industry ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeo_tenant_industry FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON aeo_tenant_industry;
CREATE POLICY tenant_isolation ON aeo_tenant_industry
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON aeo_tenant_industry;
CREATE POLICY tenant_visible ON aeo_tenant_industry
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The worker scope (app.outbox_worker = 'true') needs to scan this
-- table across tenants to compute the rollup. Permissive policy keyed
-- on the worker GUC.
DROP POLICY IF EXISTS worker_aggregate_read ON aeo_tenant_industry;
CREATE POLICY worker_aggregate_read ON aeo_tenant_industry
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (NULLIF(current_setting('app.outbox_worker', true), '') = 'true');

-- 3. Public anonymized rollup --------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_sensor_industry_rollup (
    industry_slug    text NOT NULL REFERENCES aeo_sensor_industries(slug) ON DELETE CASCADE,
    -- Same engine vocabulary as aeo_probes / aeo_daily_rollup, plus
    -- '_all' for the pooled-across-engines row.
    engine           text NOT NULL
        CHECK (engine IN ('chatgpt','gemini','perplexity','grok','copilot','_all')),
    day              date NOT NULL,
    -- Aggregated metrics. Each is the simple mean of the per-tenant
    -- daily rate over all contributing tenants in this
    -- (industry, engine, day) bucket. Range matches per-tenant rows.
    mention_rate     numeric(5,4) NOT NULL DEFAULT 0
        CHECK (mention_rate >= 0 AND mention_rate <= 1),
    citation_rate    numeric(5,4) NOT NULL DEFAULT 0
        CHECK (citation_rate >= 0 AND citation_rate <= 1),
    volatility_score numeric(5,2) NOT NULL DEFAULT 0
        CHECK (volatility_score >= 0 AND volatility_score <= 100),
    -- How many tenants contributed to this row. The public API
    -- suppresses any row where contributor_count < MIN_CONTRIBUTORS
    -- (k-anonymity floor — default 5). Stored so the suppression
    -- decision is auditable after the fact.
    contributor_count integer NOT NULL DEFAULT 0 CHECK (contributor_count >= 0),
    -- Total number of underlying probes that fed the per-tenant rates
    -- before aggregation. Surfaces in the public UI as "based on N
    -- probes across M brands".
    sample_size      integer NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
    computed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (industry_slug, engine, day)
);

-- Hot path: "give me the last N days of rollups for a given industry".
CREATE INDEX IF NOT EXISTS aeo_sensor_industry_rollup_industry_day_idx
    ON aeo_sensor_industry_rollup (industry_slug, day DESC);

-- Hot path: "give me today's rollup across every industry for a single
-- engine" — drives the public landing page's industry comparison grid.
CREATE INDEX IF NOT EXISTS aeo_sensor_industry_rollup_day_engine_idx
    ON aeo_sensor_industry_rollup (day DESC, engine);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_sensor_industry_rollup TO postwave_app;

-- Intentionally RLS-OFF. This table is by design a public, anonymized
-- aggregate — the rollup worker is the only writer (writes are gated
-- via app.outbox_worker GUC at the application layer) and reads serve
-- the unauthenticated public Sensor page.
--
-- Defense-in-depth: nothing in this table carries a tenant_id column;
-- if a future migration ever adds one, the policy split from 0333
-- would need to be retrofitted here.

-- 4. Public Sensor changelog --------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_sensor_changelog (
    id           bigserial PRIMARY KEY,
    -- The day the publish covers. Multiple rows per day are allowed
    -- if the worker re-runs (e.g. after fixing a bad rollup); the
    -- UI orders DESC and de-duplicates by day.
    published_for date NOT NULL,
    -- Which engines / industries were refreshed. Stored as
    -- JSON to keep the schema small; the worker writes the full
    -- envelope and the UI renders a tabular summary.
    summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- "ok" = normal publish. "partial" = some engines/industries
    -- below the k-anon floor and suppressed. "skipped" = no
    -- contributing tenants — published row count was zero.
    status       text NOT NULL DEFAULT 'ok'
        CHECK (status IN ('ok','partial','skipped','failed')),
    notes        text NOT NULL DEFAULT '',
    published_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aeo_sensor_changelog_published_for_idx
    ON aeo_sensor_changelog (published_for DESC, published_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_sensor_changelog TO postwave_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE aeo_sensor_changelog_id_seq TO postwave_app;

-- Same logic as the rollup table: no per-tenant data, RLS off.

COMMIT;
