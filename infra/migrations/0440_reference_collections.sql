-- 0440_reference_collections.sql
--
-- SUB-014 — reference collections (workspace-scoped lookup tables).
--
-- A reference collection is an operator-uploaded lookup table — coupon
-- pools, content blocks, or schedules — that personalization/automation
-- can read by key without the data living on every subscriber row.
-- Mirrors the commerce_catalogs pattern: tenant-scoped, RLS-protected,
-- with the row data held in a jsonb blob so the shape is flexible per
-- collection_type. Collections are workspace-scoped lookups, NOT
-- subscriber-linked, so there's no FK back to subscribers.
--
-- RLS GUC idiom is the repo standard:
--   NULLIF(current_setting('app.tenant_id', true), '')::uuid
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE
-- reference_collections.

BEGIN;

CREATE TABLE IF NOT EXISTS reference_collections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL CHECK (length(btrim(name)) > 0),
    -- What kind of lookup this is. CHECK-pinned so a drifting client can't
    -- silently land an unknown type.
    collection_type text NOT NULL DEFAULT 'content'
                    CHECK (collection_type IN ('coupons', 'content', 'schedule')),
    -- How the rows got here: a CSV/JSON upload, an external API sync, or
    -- hand-entered rows.
    source_type     text NOT NULL DEFAULT 'manual'
                    CHECK (source_type IN ('uploaded', 'api', 'manual')),
    -- The collection's rows. A JSON array of objects (one object per row).
    data            jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE reference_collections IS
    'SUB-014 workspace-scoped reference/lookup collections (coupons/content/schedule). Rows live in the data jsonb array; collections are not subscriber-linked.';

CREATE INDEX IF NOT EXISTS reference_collections_tenant_idx
    ON reference_collections (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON reference_collections TO postwave_app;

ALTER TABLE reference_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_collections FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reference_collections;
CREATE POLICY tenant_isolation ON reference_collections
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON reference_collections;
CREATE POLICY tenant_visible ON reference_collections
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
