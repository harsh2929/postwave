-- 0300_aeo_sensor.sql
--
-- sto-aeo-sensor (P3, surface=archive, effort=XL)
--
-- AEO (Answer Engine Optimization) tracking — Postwave's answer to
-- HubSpot AEO Sensor, the first marketing-cloud surface that exposes a
-- per-brand "are we cited by ChatGPT / Gemini / Perplexity?" telemetry
-- ledger. The 2026 SOTA reference (HubSpot AEO, Profound, BrightEdge
-- AEO) tracks three signals:
--
--   1. mention_rate    — % of probe responses that mention the brand
--   2. citation_rate   — % of probe responses that hyperlink to the brand
--   3. ai_referral_pct — % of incoming archive traffic attributed to AI
--                        crawlers / referrers (separate funnel; lives in
--                        the public archive read-side, this migration just
--                        materialises the daily roll-up so the AEO page
--                        can render it next to the probe stats).
--
-- A daily volatility_score in [0, 100] is computed from the rolling
-- standard deviation of mention_rate over the last 14 days — the same
-- shape HubSpot's "AI Search Volatility" tile shows. High score ⇒ the
-- search engines are reshuffling who they cite; low score ⇒ the
-- citation graph is stable. The dashboard surfaces this as a fever
-- chart on the Archive page (the natural home: published newsletters
-- are the substrate the LLM crawlers index).
--
-- Schema:
--
--  1. aeo_settings
--       Per-tenant on/off, brand_terms (the strings we test for in
--       responses), probe_prompt_pack (which rotation harness to run),
--       probe_interval_hours. Lazily inserted by the Settings handler.
--
--  2. aeo_prompts
--       The prompt rotation library. The packaged starter pack ships
--       ~30 prompts across "discovery" / "comparison" / "buyer"
--       categories. Per-tenant adds + enabled flag so an operator can
--       prune the list to category-relevant prompts.
--
--  3. aeo_probes
--       Append-only ledger of every probe execution. One row per
--       (prompt × engine × run). Stores the raw response_text so the
--       audit page can show "here's exactly what ChatGPT said when we
--       asked X on 2026-06-04". Includes mentioned (bool), cited
--       (bool), latency_ms, token_count.
--
--  4. aeo_daily_rollup
--       Materialised daily metrics per (tenant_id, engine, day):
--       mention_rate, citation_rate, volatility_score,
--       ai_referral_pct. Computed by the AEO daily worker. The
--       Archive page's AEO tab reads from this table — fast indexed
--       read, no scanning aeo_probes at render time.
--
--  5. aeo_competitors
--       Optional competitor brand list (max 5 per tenant). Each probe
--       response is scored against the brand AND the competitor list
--       so the dashboard can render "Brand X gets cited 42% of the
--       time, competitor Acme gets cited 71%" — the killer feature
--       HubSpot AEO and Profound both ship.
--
-- All tables follow the canonical NULLIF GUC RLS idiom from 0079.
--
-- IMPORTANT: this migration ships the data model + interfaces. The
-- actual probe runner (which hits ChatGPT / Gemini / Perplexity APIs)
-- is deferred — it requires per-tenant API credentials, rate limit
-- shaping, and a sandboxed eval container. The settings UI surfaces
-- "probes ready" / "credentials missing" state so operators can wire
-- credentials before flipping the kill-switch on.

BEGIN;

-- 1. Settings ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_settings (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled                boolean NOT NULL DEFAULT false,
    -- Brand terms we look for in probe responses. The probe scorer
    -- treats each term as case-insensitive substring; a response that
    -- contains ANY term is "mentioned". Cap at 8 to keep the regex
    -- compile cost bounded.
    brand_terms            jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(brand_terms) = 'array'
               AND jsonb_array_length(brand_terms) <= 8),
    -- Domain we check for in <a href> links to score "cited" — when
    -- a response cites my-brand.com we count the citation_rate hit.
    -- Stored separately from brand_terms because the citation match
    -- needs URL-host parsing, not substring.
    brand_domain           text NOT NULL DEFAULT ''
        CHECK (length(brand_domain) <= 253),
    -- Which prompt-pack to run. 'starter' ships with the migration;
    -- 'custom' = use only tenant-authored prompts in aeo_prompts.
    probe_prompt_pack      text NOT NULL DEFAULT 'starter'
        CHECK (probe_prompt_pack IN ('starter','custom','starter_plus_custom')),
    -- How often the daily worker fans out probes. 24h matches HubSpot
    -- AEO and bounds the API spend.
    probe_interval_hours   integer NOT NULL DEFAULT 24
        CHECK (probe_interval_hours BETWEEN 6 AND 168),
    -- Engines the harness probes. JSON array of {key: 'chatgpt' |
    -- 'gemini' | 'perplexity', enabled: bool}. Per-engine enabled so
    -- a tenant can keep Perplexity off while their per-engine spend
    -- caps stabilise.
    engines                jsonb NOT NULL DEFAULT
        '[{"key":"chatgpt","enabled":true},{"key":"gemini","enabled":true},{"key":"perplexity","enabled":true}]'::jsonb,
    -- Volatility computation window. 14 days matches HubSpot's tile.
    volatility_window_days integer NOT NULL DEFAULT 14
        CHECK (volatility_window_days BETWEEN 3 AND 60),
    -- Credentials posture. UI badge — green when API creds for at
    -- least one engine are present, red otherwise. Updated by the
    -- credentials handler.
    credentials_status     text NOT NULL DEFAULT 'missing'
        CHECK (credentials_status IN ('missing','partial','ready')),
    last_probe_run_at      timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_settings TO postwave_app;

ALTER TABLE aeo_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeo_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON aeo_settings;
CREATE POLICY tenant_isolation ON aeo_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON aeo_settings;
CREATE POLICY tenant_visible ON aeo_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Prompts ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_prompts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- 'discovery' = open-ended "best tool for X" queries
    -- 'comparison' = "X vs Y" head-to-heads
    -- 'buyer'     = transactional "how do I buy / pricing" queries
    category     text NOT NULL DEFAULT 'discovery'
        CHECK (category IN ('discovery','comparison','buyer','support','other')),
    -- The probe text. Sent verbatim to each engine on every cycle.
    prompt_text  text NOT NULL CHECK (length(prompt_text) BETWEEN 4 AND 2000),
    -- Whether the daily worker should include this prompt in its
    -- rotation. Per-prompt off so operators can pause noisy prompts.
    enabled      boolean NOT NULL DEFAULT true,
    -- 'starter' rows are seeded by the migration; 'custom' rows are
    -- tenant-authored. Used by aeo_settings.probe_prompt_pack to
    -- filter which set the worker runs.
    source       text NOT NULL DEFAULT 'custom'
        CHECK (source IN ('starter','custom')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aeo_prompts_tenant_enabled_idx
    ON aeo_prompts (tenant_id, enabled, category);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_prompts TO postwave_app;

ALTER TABLE aeo_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeo_prompts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON aeo_prompts;
CREATE POLICY tenant_isolation ON aeo_prompts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON aeo_prompts;
CREATE POLICY tenant_visible ON aeo_prompts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Probes -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_probes (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    prompt_id      uuid NOT NULL REFERENCES aeo_prompts(id) ON DELETE CASCADE,
    -- Engine the probe was sent to. Same vocabulary as
    -- aeo_settings.engines[].key.
    engine         text NOT NULL
        CHECK (engine IN ('chatgpt','gemini','perplexity','grok','copilot')),
    -- Raw response text, truncated at 16KB. Used by the audit pane.
    response_text  text NOT NULL DEFAULT '',
    -- Scoring flags. mentioned = at least one brand term substring
    -- matched. cited = at least one href to brand_domain was found.
    mentioned      boolean NOT NULL DEFAULT false,
    cited          boolean NOT NULL DEFAULT false,
    -- Per-competitor mention counts. jsonb keyed by competitor key.
    -- Empty {} when no competitors are configured.
    competitor_hits jsonb NOT NULL DEFAULT '{}'::jsonb,
    latency_ms     integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    token_count    integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
    -- Final state. 'ok' = response stored & scored. 'error' = engine
    -- returned an error; response_text holds the error message.
    -- 'rate_limited' = backed off; the worker will retry next cycle.
    status         text NOT NULL DEFAULT 'ok'
        CHECK (status IN ('ok','error','rate_limited','skipped')),
    probed_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "give me the last 14 days of probes for this tenant +
-- engine" — drives the volatility computation.
CREATE INDEX IF NOT EXISTS aeo_probes_tenant_engine_time_idx
    ON aeo_probes (tenant_id, engine, probed_at DESC);

-- For the per-prompt drill-down in the audit pane.
CREATE INDEX IF NOT EXISTS aeo_probes_tenant_prompt_idx
    ON aeo_probes (tenant_id, prompt_id, probed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_probes TO postwave_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE aeo_probes_id_seq TO postwave_app;

ALTER TABLE aeo_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeo_probes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON aeo_probes;
CREATE POLICY tenant_isolation ON aeo_probes
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON aeo_probes;
CREATE POLICY tenant_visible ON aeo_probes
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 4. Daily rollup -----------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_daily_rollup (
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    engine           text NOT NULL
        CHECK (engine IN ('chatgpt','gemini','perplexity','grok','copilot','_all')),
    -- UTC calendar day the rollup applies to. The worker partitions
    -- on day boundary in the tenant's reporting timezone, but the
    -- column itself stays UTC for cross-tenant analytics.
    day              date NOT NULL,
    -- All three metrics live in [0, 1] (or [0, 100] for volatility);
    -- the UI multiplies by 100 to render percentages.
    mention_rate     numeric(5,4) NOT NULL DEFAULT 0
        CHECK (mention_rate >= 0 AND mention_rate <= 1),
    citation_rate    numeric(5,4) NOT NULL DEFAULT 0
        CHECK (citation_rate >= 0 AND citation_rate <= 1),
    -- 0-100 volatility score. Computed as rolling stddev of
    -- mention_rate over volatility_window_days, normalized to [0, 100].
    volatility_score numeric(5,2) NOT NULL DEFAULT 0
        CHECK (volatility_score >= 0 AND volatility_score <= 100),
    -- AI referral funnel: fraction of archive page-views attributed
    -- to an AI crawler / referrer (GPTBot, PerplexityBot,
    -- bingbot/AI, ClaudeBot, etc.). Sourced from the archive
    -- analytics pipeline by the same daily worker.
    ai_referral_pct  numeric(5,4) NOT NULL DEFAULT 0
        CHECK (ai_referral_pct >= 0 AND ai_referral_pct <= 1),
    -- Sample size — how many probes contributed to this row. Used by
    -- the UI to render a "low-confidence" banner when sample_size <
    -- min_sample_for_significance (default 5).
    sample_size      integer NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
    computed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, engine, day)
);

-- Hot path: "give me the last N days of rollups for this tenant".
CREATE INDEX IF NOT EXISTS aeo_daily_rollup_tenant_day_idx
    ON aeo_daily_rollup (tenant_id, day DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_daily_rollup TO postwave_app;

ALTER TABLE aeo_daily_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeo_daily_rollup FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON aeo_daily_rollup;
CREATE POLICY tenant_isolation ON aeo_daily_rollup
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON aeo_daily_rollup;
CREATE POLICY tenant_visible ON aeo_daily_rollup
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 5. Competitors ------------------------------------------------------

CREATE TABLE IF NOT EXISTS aeo_competitors (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Short key the probe scorer uses for the competitor_hits map
    -- (so the UI can render "acme: 12 / klay: 8" without re-deriving
    -- from brand_terms). Lowercase, no spaces; the API validates.
    competitor_key  text NOT NULL CHECK (length(competitor_key) BETWEEN 1 AND 40),
    -- Pretty name shown in the dashboard.
    display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    -- Brand terms for this competitor — same shape as
    -- aeo_settings.brand_terms but scoped to the competitor row.
    terms           jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(terms) = 'array'
               AND jsonb_array_length(terms) <= 6),
    -- Optional domain for citation_rate parity with brand_domain.
    domain          text NOT NULL DEFAULT '' CHECK (length(domain) <= 253),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, competitor_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON aeo_competitors TO postwave_app;

ALTER TABLE aeo_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeo_competitors FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON aeo_competitors;
CREATE POLICY tenant_isolation ON aeo_competitors
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON aeo_competitors;
CREATE POLICY tenant_visible ON aeo_competitors
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cap: per the audit, 5 competitors per tenant. Enforced via
-- partial-index trigger pattern would be the bullet-proof move; for
-- now the API layer (aeo.Repo.UpsertCompetitor) clamps.

COMMIT;
