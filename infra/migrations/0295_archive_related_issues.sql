-- 0286_archive_related_issues.sql
--
-- Adds the schema groundwork for "Read next" / related-issues
-- recommendations on the public archive issue page.
--
-- Three concerns layered into one migration:
--
--   1. campaigns.archive_tags text[] — tag overlap is the single
--      cheapest relevancy signal (Ghost's related_blog_posts HubL tag
--      drives off the same primitive). A GIN index keeps the
--      `archive_tags && other.archive_tags` overlap query O(matches)
--      rather than O(tenant rows).
--
--   2. archive_related_overrides — admin-curated per-issue override.
--      When an operator wants to pin "Read this next" to a specific
--      sibling issue (e.g. multi-part series), the override table
--      short-circuits the relevancy scorer entirely. Ordered by
--      `rank ASC` so the slideover can drag-and-drop.
--
--   3. The relevancy scorer itself is pure SQL — it runs inside the
--      existing transaction the public handler already opens, so no
--      new column is needed on archive_views (the 30-day popularity
--      signal is derived from that table at query-time).
--
-- Inspired by 2026 SOTA: HubSpot (related-posts widget), Ghost
-- (related_blog_posts with a relevancy-score knob), Substack
-- (read-next carousel).

BEGIN;

-- 1. Per-issue tag list. Lives on `campaigns` because the archive
--    surface is just the published-campaigns projection — keeping the
--    tags inline avoids a join on every list/detail render, and it
--    matches the same `text[]` shape we already use on
--    `subscribers.tags` and `campaign_templates.tags`.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS archive_tags text[] NOT NULL DEFAULT '{}';

-- GIN index for the overlap (`&&`) and contains (`@>`) operators the
-- relevancy scorer uses. Partial on archive_public so we don't index
-- draft / sending / paused campaigns the public surface never reads.
CREATE INDEX IF NOT EXISTS campaigns_archive_tags_gin_idx
    ON campaigns USING GIN (archive_tags)
    WHERE archive_public = true;

-- 2. Per-post admin override. Either side empty falls back to the
--    auto-scored list. (campaign_id, rank) is the natural sort key.
CREATE TABLE IF NOT EXISTS archive_related_overrides (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- "From" campaign — the issue whose detail page renders the carousel.
    campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    -- "To" campaign — the sibling that should appear in the carousel.
    related_campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    -- 0-based ordering inside the override list. Smaller = earlier.
    rank                int  NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- Disallow self-recommendation; the public scorer also filters,
    -- but a CHECK at write-time keeps the table from accumulating
    -- nonsense rows from a buggy admin client.
    CONSTRAINT archive_related_no_self CHECK (campaign_id <> related_campaign_id),
    -- One entry per (from, to) pair per tenant; rank changes update
    -- in place via INSERT ... ON CONFLICT DO UPDATE.
    UNIQUE (tenant_id, campaign_id, related_campaign_id)
);

CREATE INDEX IF NOT EXISTS archive_related_overrides_lookup_idx
    ON archive_related_overrides (tenant_id, campaign_id, rank);

GRANT SELECT, INSERT, UPDATE, DELETE ON archive_related_overrides TO postwave_app;

ALTER TABLE archive_related_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_related_overrides FORCE ROW LEVEL SECURITY;

-- Tenant-isolation: standard NULLIF idiom — a raw cast crashes when
-- the GUC is unset, the NULLIF returns NULL and the predicate
-- short-circuits cleanly.
CREATE POLICY tenant_isolation ON archive_related_overrides
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON archive_related_overrides
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
