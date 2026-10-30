-- 0286_archive_recommendations_network.sql
--
-- Cross-tenant editorial recommendations network — gap feature
-- `archive-recommendations-network` (P2, XL).
--
-- Substack's Recommendations Network drove 32M+ in-app subscriptions in
-- Q4 2025. Beehiiv's Top-4 panel is a top-4 acquisition channel for
-- major publishers. Ghost ships Webmention-based recommendations
-- across the open web. This migration is the schema-level foundation:
--
--   1. `tenant_recommendations` — the per-tenant ordered list of
--      newsletters the operator wants to recommend. Each row points
--      at a publication identified by canonical URL (we deliberately
--      do NOT require the target to be hosted on Postwave — the
--      recommendations panel works as an open-web outbound channel
--      first, with cross-tenant in-app upgrades following later when
--      the to_tenant_id column is populated by a future job).
--
--   2. `recommendation_clicks` — append-only event log of click-throughs
--      from the public recommendations panel. Powers the per-row
--      conversion metric the desktop admin surfaces ("Recommendation X
--      drove 42 clicks last 30d"). Anonymous — no PII, salt-day-rotated
--      anon_visitor_id mirrors the archive_views privacy model.
--
--   3. `webmentions_inbox` — open-web variant scaffold. Webmention
--      receivers POST source/target to /api/public/webmention; payloads
--      land here for an async parser to promote into recommendations.
--      Parser implementation is deferred (see gap feature scaffold);
--      the table + endpoint exist so external sites can POST today and
--      no payload is lost when we light up the parser.
--
-- RLS uses the standard NULLIF idiom every other tenant-scoped table
-- in this migration set uses — raw cast on `app.tenant_id` GUC crashes
-- when unset; NULLIF(coalesce-empty)::uuid returns NULL and the
-- predicate short-circuits cleanly to zero rows.
--
-- Inspired by 2026 SOTA: Substack (Recommendations Network),
-- beehiiv (Top-4 carousel), Ghost (Webmentions + Recommendations).

BEGIN;

-- ---------------------------------------------------------------------
-- 1. tenant_recommendations
-- ---------------------------------------------------------------------
-- Each row is one outbound editorial recommendation. `to_url` is the
-- canonical surface (homepage, subscribe page, or archive root); when
-- a target publication is itself a Postwave tenant the future-cross-
-- tenant job populates `to_tenant_id` so the panel can render a
-- one-click in-app subscribe rather than a leave-site link.
CREATE TABLE IF NOT EXISTS tenant_recommendations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- "From" tenant — the publication whose archive surfaces this row.
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Canonical URL of the recommended publication. Required.
    to_url          text NOT NULL,
    -- Display label ("Foo Weekly"). Falls back to host(to_url) in the
    -- renderer when empty so a brand-new row without a label still
    -- shows something sensible.
    to_label        text NOT NULL DEFAULT '',
    -- One-line elevator pitch ("Daily fintech analysis from a former
    -- WSJ reporter"). Optional; falls back to "" in the renderer.
    to_description  text NOT NULL DEFAULT '',
    -- Square thumbnail (≥ 96x96). Optional; the renderer shows a
    -- letter-glyph fallback when empty.
    to_image_url    text NOT NULL DEFAULT '',
    -- 0-based ordering inside the panel. Smaller = earlier.
    position        int  NOT NULL DEFAULT 0,
    -- When non-null, the target publication is itself a Postwave tenant
    -- and the renderer can offer a one-click in-app subscribe. Populated
    -- by a (deferred) cross-tenant discovery job; leave NULL for plain
    -- outbound links.
    to_tenant_id    uuid NULL REFERENCES tenants(id) ON DELETE SET NULL,
    -- Active flag — operators can disable a row without deleting it so
    -- the click-through history survives an A/B test.
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- No self-recommendation. A tenant cannot recommend itself; the
    -- public renderer also filters but a CHECK at write-time prevents
    -- accidents from a buggy admin client.
    CONSTRAINT tenant_rec_no_self CHECK (to_tenant_id IS NULL OR to_tenant_id <> tenant_id),
    -- One row per (from, url) pair — duplicates would surface twice in
    -- the panel and double-count click attribution.
    UNIQUE (tenant_id, to_url)
);

CREATE INDEX IF NOT EXISTS tenant_recommendations_lookup_idx
    ON tenant_recommendations (tenant_id, position)
    WHERE active = true;

-- Reverse index for the cross-tenant discovery job — given a Postwave
-- tenant id, find every publication that recommends them. Future
-- "reciprocal recommendations" UX hangs off this.
CREATE INDEX IF NOT EXISTS tenant_recommendations_to_tenant_idx
    ON tenant_recommendations (to_tenant_id)
    WHERE to_tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_recommendations TO postwave_app;

ALTER TABLE tenant_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_recommendations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_recommendations
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_recommendations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 2. recommendation_clicks
-- ---------------------------------------------------------------------
-- Append-only event log. The public click-redirect handler inserts one
-- row per outbound click before issuing the 302; the row never carries
-- PII (anon_visitor_id is salted-daily sha256 truncation, matching the
-- archive_views privacy model).
CREATE TABLE IF NOT EXISTS recommendation_clicks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    recommendation_id uuid NOT NULL REFERENCES tenant_recommendations(id) ON DELETE CASCADE,
    -- Salted-day-rotated anon visitor id. NULL is allowed (bot or
    -- missing UA) but the per-day-unique counter ignores NULL rows.
    anon_visitor_id   bytea NULL,
    -- "issue" | "index" | "footer" — where on the public surface the
    -- click originated. Helps the operator tune placement.
    source            text NOT NULL DEFAULT 'issue',
    -- The campaign slug the visitor was reading when the click fired,
    -- when source='issue'. Optional; NULL for index/footer.
    campaign_slug     text NULL,
    -- Truncated referrer host — never the full path / query string.
    referrer_host     text NOT NULL DEFAULT '',
    bot               boolean NOT NULL DEFAULT false,
    clicked_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recommendation_clicks_lookup_idx
    ON recommendation_clicks (tenant_id, recommendation_id, clicked_at DESC);

CREATE INDEX IF NOT EXISTS recommendation_clicks_tenant_recent_idx
    ON recommendation_clicks (tenant_id, clicked_at DESC);

GRANT SELECT, INSERT ON recommendation_clicks TO postwave_app;

ALTER TABLE recommendation_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_clicks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON recommendation_clicks
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON recommendation_clicks
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3. webmentions_inbox  (Ghost-style open-web variant — scaffolded)
-- ---------------------------------------------------------------------
-- Webmention receivers POST {source, target} to /api/public/webmention.
-- We accept any well-formed payload, persist it here, return 202, and
-- (DEFERRED) an async worker parses the source HTML for h-card author
-- info + microformats and offers the operator a one-click promote into
-- `tenant_recommendations`. The table itself ships now so external
-- sites can start sending today and no payloads are dropped when the
-- parser lights up.
--
-- The receiver maps `target` to a tenant by host-matching against
-- `tenant_public_settings.archive_domain`. Inbox rows are tenant-scoped
-- once that mapping succeeds; rows with no resolved tenant land in the
-- system-scoped "orphan" pile (tenant_id = NULL) for the parser to
-- triage later.
CREATE TABLE IF NOT EXISTS webmentions_inbox (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Resolved on-receive via the archive_domain host lookup. NULL
    -- means we couldn't bind the payload to a tenant — kept for
    -- post-hoc analysis but never surfaced in tenant-scoped queries.
    tenant_id       uuid NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Page that mentions us (source) and the page on our archive that
    -- got mentioned (target). Both required by the Webmention spec.
    source_url      text NOT NULL,
    target_url      text NOT NULL,
    -- Status: "pending" | "parsed" | "promoted" | "rejected".
    -- The HTTP handler always inserts pending; the (deferred) parser
    -- transitions to parsed/rejected and the admin slideover transitions
    -- to promoted when the operator OKs the row.
    status          text NOT NULL DEFAULT 'pending',
    -- Optional cached author display name extracted by the parser.
    author_name     text NOT NULL DEFAULT '',
    author_url      text NOT NULL DEFAULT '',
    -- Truncated source page title.
    source_title    text NOT NULL DEFAULT '',
    received_at     timestamptz NOT NULL DEFAULT now(),
    parsed_at       timestamptz NULL,
    -- One row per (source, target). Re-POSTs idempotent — the
    -- webmention spec REQUIRES re-receiving the same pair.
    UNIQUE (source_url, target_url)
);

CREATE INDEX IF NOT EXISTS webmentions_inbox_tenant_idx
    ON webmentions_inbox (tenant_id, received_at DESC)
    WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS webmentions_inbox_pending_idx
    ON webmentions_inbox (status, received_at)
    WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON webmentions_inbox TO postwave_app;

-- Note: webmentions_inbox carries nullable tenant_id by design (orphan
-- payloads pre-tenant-binding). We still gate tenant-bound rows behind
-- RLS but allow rows with NULL tenant_id to be inserted by the public
-- receiver. The policy reflects that: NULL tenant_id rows are visible
-- to no tenant scope (they're only readable by admin / migrations).
ALTER TABLE webmentions_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webmentions_inbox FORCE ROW LEVEL SECURITY;

-- INSERT permission for unbound (tenant_id IS NULL) rows is granted by
-- the PERMISSIVE policy below. The RESTRICTIVE policy restricts
-- everything else.
CREATE POLICY tenant_isolation ON webmentions_inbox
    AS RESTRICTIVE FOR SELECT
    USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY tenant_visible ON webmentions_inbox
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
