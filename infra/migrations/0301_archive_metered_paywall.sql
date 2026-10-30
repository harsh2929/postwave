-- 0297_archive_metered_paywall.sql
--
-- Metered paywall with reset cadences (gap feature
-- `archive-metered-paywall`, P1, surface=archive). Inspired by beehiiv's
-- 2026 SOTA metered paywall + classic NYT/FT free-N-articles model.
--
-- Builds on the existing per-campaign `paywall-integration` (0054):
-- where 0054 ships a per-issue hard gate ("members"/"paid" visibility),
-- this migration ships a *soft* gate keyed on per-visitor read count.
-- An anonymous visitor can read up to `quota` issues for free, then
-- gets a customizable paywall response on the (quota+1)th issue. The
-- counter resets on the configured cadence (daily/weekly/monthly/
-- yearly/never).
--
-- The two paywalls compose naturally:
--   * If 0054's visibility is 'paid' AND the visitor is a paid member,
--     no metered check runs (already entitled).
--   * If 0054's visibility is 'public' the metered check fires on the
--     archive read path; the response carries either the full body or
--     a teaser + paywall payload.
--
-- Search visibility (critical for SEO): the metered gate must NOT hide
-- issues from search engines, otherwise indexing breaks. The renderer
-- handles this by detecting common search-engine User-Agents and
-- bypassing the gate for them. Sitemaps/feeds also bypass.
--
-- ----------------------------------------------------------------------
-- Schema overview
--
--   tenant_metered_paywall — one row per tenant carrying the quota,
--     reset cadence, paywall messaging + CTA, and reset bookkeeping.
--     Defaults are "metered paywall off" (quota=0) so the migration is
--     purely additive — existing tenants keep their current behaviour
--     until they opt in.
--
--   anon_visitor_meter — one row per (tenant, anon_visitor_id, period
--     bucket) tracking the count of distinct issues read in the current
--     reset window. `period_started_at` is the timestamp at which the
--     visitor's bucket opened; the worker compares it with
--     tenant_metered_paywall.reset_cadence and clears stale rows out of
--     band. The unique constraint on (tenant_id, anon_visitor_id)
--     keeps the table compact: one row per visitor regardless of how
--     many issues they read.
--
--   anon_visitor_meter_reads — the actual issue→visitor join used to
--     compute "how many DISTINCT issues has this visitor read in the
--     current period". Append-only; the reset worker truncates rows
--     whose `(tenant_id, anon_visitor_id, period_started_at)` falls
--     outside the cadence window.

BEGIN;

-- 1. Tenant-level metered paywall config. One row per tenant (PK is
--    tenant_id) so the read path is a single indexed lookup. NULL row
--    = feature unused (handled in the Go layer with a zero-value
--    fallback). Quota default = 0 means "metered paywall off" so the
--    migration doesn't accidentally start paywalling every tenant.
CREATE TABLE IF NOT EXISTS tenant_metered_paywall (
    tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- quota=0 → metered paywall OFF; the read path skips the meter
    -- entirely. quota=N → visitors see N issues free before the gate.
    -- Capped at 1000 so a typo can't make the meter functionally
    -- unlimited (defeating the gate would surprise the operator).
    quota               integer NOT NULL DEFAULT 0
                        CHECK (quota >= 0 AND quota <= 1000),
    -- 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'.
    -- 'never' = visitor's allowance lasts for the lifetime of their
    -- anon_visitor_id (≈ until they clear cookies). The classic NYT
    -- model is 'monthly'; beehiiv defaults to 'weekly'.
    reset_cadence       text NOT NULL DEFAULT 'monthly'
                        CHECK (reset_cadence IN ('daily','weekly','monthly','yearly','never')),
    -- Customizable paywall messaging surfaced via the public archive
    -- response. The desktop's metered-paywall settings card writes
    -- these in plain text — the renderer escapes them at output time.
    -- Empty string falls back to a localised default in the
    -- frontend renderer.
    paywall_title       text NOT NULL DEFAULT '',
    paywall_body        text NOT NULL DEFAULT '',
    paywall_cta_label   text NOT NULL DEFAULT '',
    paywall_cta_href    text NOT NULL DEFAULT '',
    -- Optional reference to a "paid tier" the CTA upsells towards.
    -- When set + the visitor is a paid_members.status='active' caller
    -- for that tier, the meter is bypassed. Empty string = "any paid
    -- subscription bypasses the meter" (same any-tier semantics that
    -- 0288 podcast tiers use). Kept as text rather than a hard FK
    -- because paid_members.tier is itself free-text.
    paywall_tier        text NOT NULL DEFAULT '',
    -- When true the renderer ALSO returns the teaser + paywall payload
    -- to common search-engine User-Agents (Googlebot, Bingbot, …).
    -- Default false so SEO indexing keeps working out of the box — this
    -- mirrors the NYT/FT "First Click Free" pattern. Operators who
    -- specifically want to block crawlers can flip the bit.
    block_search_bots   boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenant_metered_paywall_set_updated_at
    BEFORE UPDATE ON tenant_metered_paywall
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_metered_paywall TO postwave_app;

ALTER TABLE tenant_metered_paywall ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_metered_paywall FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_metered_paywall
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Per-visitor meter bucket. One row per (tenant, anon_visitor_id) —
--    the bucket is shared across all issues for a single visitor.
--    `period_started_at` is the timestamp the bucket opened; the
--    reset worker uses this + the cadence to clear stale rows.
--
--    `last_seen_at` lets us garbage-collect dormant rows even when
--    the cadence is 'never' — a visitor who reads once and never
--    returns shouldn't pin a row forever.
CREATE TABLE IF NOT EXISTS anon_visitor_meter (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- 32-char anon_visitor_id matches the hash used by archive_views.
    -- We store as text (citext-equivalent) so the read path can do
    -- equality on the cookie value verbatim.
    anon_visitor_id     text NOT NULL,
    period_started_at   timestamptz NOT NULL DEFAULT now(),
    -- read_count is denormalized from anon_visitor_meter_reads so the
    -- hot read path is a single indexed lookup (no DISTINCT subquery
    -- on the read path). The reads table is the source of truth; the
    -- worker recomputes this column on reset.
    read_count          integer NOT NULL DEFAULT 0 CHECK (read_count >= 0),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, anon_visitor_id)
);

CREATE INDEX IF NOT EXISTS anon_visitor_meter_last_seen_idx
    ON anon_visitor_meter (tenant_id, last_seen_at);
CREATE INDEX IF NOT EXISTS anon_visitor_meter_period_idx
    ON anon_visitor_meter (tenant_id, period_started_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON anon_visitor_meter TO postwave_app;

ALTER TABLE anon_visitor_meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE anon_visitor_meter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON anon_visitor_meter
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Append-only (visitor, issue) reads. The read path inserts ON
--    CONFLICT DO NOTHING (idempotent — re-reading the same issue
--    twice in the same period must NOT decrement the visitor's
--    remaining allowance). The worker uses this to recompute the
--    denormalized read_count column on reset.
CREATE TABLE IF NOT EXISTS anon_visitor_meter_reads (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    anon_visitor_id     text NOT NULL,
    campaign_id         uuid NOT NULL,
    period_started_at   timestamptz NOT NULL,
    first_read_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, anon_visitor_id, campaign_id, period_started_at)
);

CREATE INDEX IF NOT EXISTS anon_visitor_meter_reads_period_idx
    ON anon_visitor_meter_reads (tenant_id, period_started_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON anon_visitor_meter_reads TO postwave_app;

ALTER TABLE anon_visitor_meter_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE anon_visitor_meter_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON anon_visitor_meter_reads
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
