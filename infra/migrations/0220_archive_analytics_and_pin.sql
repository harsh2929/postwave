-- 0220_archive_analytics_and_pin.sql
--
-- Turns the public archive (campaigns.archive_public = true) into a
-- real product surface with view metrics, pin / featured ordering,
-- and the SEO knobs you need to ship issues that look good when
-- shared on social.
--
-- Three concerns, one migration:
--
--   1. `archive_views` — append-only, per-render row. The public
--      issue page fires a 1x1 pixel; the row is grouped + counted in
--      list aggregates + the dashboard stats tiles. We deliberately
--      do NOT track on the JSON/list endpoints — only the
--      human-facing detail-page renders, so bot scrapes of the
--      sitemap don't inflate numbers.
--
--      anon_visitor_id is a short server-issued cookie (sha256 of
--      ip+ua+rotating-salt, truncated to 16 bytes hex), good enough
--      for "unique visitors today" without ever storing IP. The
--      rotating salt rotates per UTC day so the same human counts
--      once per day per issue.
--
--   2. `campaigns.archive_pinned` — boolean for "feature this issue
--      at the top of the public archive index". Ordering: pinned
--      DESC, finished_at DESC. The dashboard exposes a pin toggle in
--      the slideover.
--
--   3. SEO knobs on campaigns (archive_meta_description /
--      archive_og_image / archive_hero_image / archive_author).
--      These hydrate the `<meta>` tags on the public issue page so
--      Twitter / Bluesky / LinkedIn previews look right; the body
--      img/h1 fall back to subject + excerpt when unset.

BEGIN;

-- 1. archive_views — append-only event log.
CREATE TABLE archive_views (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 16-byte hex; truncated sha256(ip || ua || daily_salt). Enough
    -- entropy for unique-counts-per-day, no PII at rest.
    anon_visitor_id TEXT,
    referrer TEXT,
    -- 2-letter; populated from cf-ipcountry / x-vercel-ip-country
    -- when present. Empty string otherwise — never NULL so GROUP BY
    -- stays uniform.
    country TEXT NOT NULL DEFAULT '',
    -- Set true when the UA matches a known crawler regex. Stored so
    -- we can show the raw + the human-only counts side-by-side; the
    -- default "view count" used in the dashboard excludes bots.
    bot BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX archive_views_campaign_idx
    ON archive_views (tenant_id, campaign_id, viewed_at DESC);
CREATE INDEX archive_views_tenant_recent_idx
    ON archive_views (tenant_id, viewed_at DESC);
-- Unique-visitor counts collapse on (campaign_id, anon_visitor_id, day).
-- The partial index speeds the COUNT(DISTINCT anon_visitor_id) path.
CREATE INDEX archive_views_unique_idx
    ON archive_views (tenant_id, campaign_id, anon_visitor_id)
    WHERE anon_visitor_id IS NOT NULL;

GRANT SELECT, INSERT ON archive_views TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE archive_views_id_seq TO postwave_app;

ALTER TABLE archive_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_views FORCE ROW LEVEL SECURITY;

-- Mirror the RESTRICTIVE + PERMISSIVE pair the rest of the schema
-- standardized on in 0079. Public INSERTs from the tracking pixel
-- arrive with the tenant id we just resolved from the public slug,
-- so they pass the same predicate as admin reads.
CREATE POLICY tenant_isolation ON archive_views
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON archive_views
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. archive_pinned + SEO columns on campaigns.
ALTER TABLE campaigns
    ADD COLUMN archive_pinned         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN archive_meta_description TEXT,
    ADD COLUMN archive_og_image       TEXT,
    ADD COLUMN archive_hero_image     TEXT,
    ADD COLUMN archive_author_name    TEXT;

-- Partial index so the public list endpoint's ORDER BY pinned DESC,
-- finished_at DESC stays cheap as the archive grows.
CREATE INDEX campaigns_archive_pinned_idx
    ON campaigns (tenant_id, archive_pinned, finished_at DESC)
    WHERE archive_public = true;

COMMIT;
