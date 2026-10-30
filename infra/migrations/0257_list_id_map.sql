-- 0257_list_id_map.sql
--
-- GAP-LS-045: durable mapping between Postwave-side list uuids and
-- Listmonk-side list bigint ids. Today CountListAudience receives
-- a bigint input but the rest of the surface uses uuid — the silent
-- "returns 0" bug the gap doc calls out comes from this mismatch.
--
-- The map is per-tenant (a tenant's lists are scoped to its
-- Listmonk workspace) and one-to-one in both directions. The Go
-- side reads the map once at list-creation time and caches the
-- pair in memory; cache invalidation is on list-delete only.
--
-- Schema:
--   - postwave_uuid: the Postwave-side uuid (the foreign key target
--     for list_subscribers.list_id, etc.).
--   - listmonk_bigint_id: the Listmonk id used by the upstream API.
--   - tenant_id: scoping for RLS. Both ids are unique within tenant
--     so callers can look up either way with a single tenant scan.
--
-- Idempotency: the table is populated by the list-create handler at
-- creation time; we treat ON CONFLICT (postwave_uuid) DO NOTHING as
-- the no-op path for handler retries.

BEGIN;

CREATE TABLE IF NOT EXISTS list_id_map (
    postwave_uuid       uuid PRIMARY KEY,
    listmonk_bigint_id  bigint NOT NULL,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, listmonk_bigint_id)
);

CREATE INDEX IF NOT EXISTS list_id_map_tenant_idx
    ON list_id_map (tenant_id);

CREATE INDEX IF NOT EXISTS list_id_map_listmonk_idx
    ON list_id_map (listmonk_bigint_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON list_id_map TO postwave_app;

ALTER TABLE list_id_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_id_map FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON list_id_map
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON list_id_map
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
