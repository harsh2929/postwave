-- 0341_template_thumbnail_cache.sql
--
-- Phase 2 deeper-investment `p2-template-png-snapshots` — adds a small
-- cache table for server-rendered template thumbnails. Eliminates the
-- per-card iframe parse cost on the Templates page (the audit flagged
-- this as the slowest interactive surface in the operator desktop).
--
-- Design notes
--   * One row per (template_id) — we keep the LAST rendered PNG only.
--     The cache invalidates on update via the `content_hash` column: a
--     GET asks for the current hash, and if it doesn't match what's
--     stored, the handler regenerates and overwrites the row.
--   * `png` lives as a `bytea` for a v1 ship. Disk/S3 offload is
--     trivial once we see the page weight; the on-disk size for a 600x400
--     PNG built from primitives stays well under 10 KB so a few thousand
--     rows are fine in the row store.
--   * Tenant scoping: the templates table itself can be platform-shared
--     (tenant_id NULL) or tenant-owned. The cache mirrors the parent —
--     `tenant_id` is nullable here for the same reason. RLS lets a
--     tenant read its own thumbnails + platform thumbnails.
--   * Regeneration worker scans rows where (a) the linked
--     `campaign_templates.updated_at` is newer than `generated_at`, or
--     (b) the cache row is missing entirely. Index supports both.

BEGIN;

CREATE TABLE IF NOT EXISTS template_thumbnails (
    template_id   uuid PRIMARY KEY REFERENCES campaign_templates(id) ON DELETE CASCADE,
    -- NULL for platform templates (mirrors campaign_templates.tenant_id).
    tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
    -- sha256(subject || \x1f || body_html) — used to invalidate the
    -- cache when the source template changes. Stable hex string so
    -- the GET handler can compare without a hash recompute.
    content_hash  text NOT NULL,
    -- Raw PNG payload. Bounded by the renderer at 600x400 +
    -- single-color rectangles; expect <10 KB per row.
    png           bytea NOT NULL,
    width         integer NOT NULL DEFAULT 600,
    height        integer NOT NULL DEFAULT 400,
    generated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_thumbnails_tenant
    ON template_thumbnails (tenant_id, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON template_thumbnails TO postwave_app;

ALTER TABLE template_thumbnails ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_thumbnails FORCE  ROW LEVEL SECURITY;

-- RLS: tenant rows are tenant-scoped; platform rows (tenant_id NULL)
-- are readable by any tenant, mirroring campaign_templates. Writes
-- come from the app role under tenant context — the
-- `app.outbox_worker` GUC lets the regeneration worker bypass the
-- tenant predicate.
CREATE POLICY template_thumbnails_select ON template_thumbnails
    FOR SELECT TO postwave_app
    USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY template_thumbnails_insert ON template_thumbnails
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY template_thumbnails_update ON template_thumbnails
    FOR UPDATE TO postwave_app
    USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY template_thumbnails_delete ON template_thumbnails
    FOR DELETE TO postwave_app
    USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
