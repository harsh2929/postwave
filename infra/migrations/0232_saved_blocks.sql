-- 0224_saved_blocks.sql
--
-- Workstream 4 (Mailchimp parity polish) — reusable block library.
--
-- Operators save a configured block (or a multi-block snippet) under a
-- name; subsequent templates / campaigns can drop it back into the
-- canvas. Mirrors Mailchimp's "Saved blocks" surface.
--
-- We persist both the rendered HTML (so the preview thumbnail can render
-- without invoking the compose endpoint) and the structured JSON
-- (block_id + config tree, used to re-hydrate the saved block back into
-- the editor's instance list).

BEGIN;

CREATE TABLE saved_blocks (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    kind        text        NOT NULL DEFAULT 'block'
                CHECK (kind IN ('block','snippet','section')),
    body_html   text        NOT NULL DEFAULT '',
    body_json   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX saved_blocks_tenant_kind_idx ON saved_blocks (tenant_id, kind, updated_at DESC);

COMMIT;
