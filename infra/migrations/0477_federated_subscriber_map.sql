-- 0477_federated_subscriber_map.sql
--
-- SUB-023 — Cross-tenant subscriber federation for agency/MSP workspaces.
--
-- Agency tenancy already exists: tenants.parent_tenant_id +
-- tenants.is_agency_account (migration 0127). A subscriber that appears in
-- several child workspaces of the same agency (the same human, signed up in
-- two of the agency's client newsletters) has no way today to be represented
-- as one master identity at the parent level.
--
-- This migration adds an explicit, opt-in federation link table. Each row links
-- a *child* subscriber (child_subscriber_id, owned by the row's tenant_id) to a
-- *master* subscriber (master_subscriber_id) living in the agency
-- parent_tenant_id workspace, keyed by the matching identifier (email or
-- external_id) recorded in match_key / match_type for provenance.
--
-- RLS model (deliberately RLS-clean, no cross-tenant policy):
--   * The row is OWNED by the child tenant (tenant_id = the child workspace).
--     A request scoped to the child tenant manages its own federation links via
--     the per-subscriber endpoints; the standard tenant_isolation policy keyed
--     on app.tenant_id applies unchanged.
--   * parent_tenant_id + master_subscriber_id are plain reference columns. The
--     parent/child relationship is VERIFIED in application code against
--     tenants.parent_tenant_id before a link is created, so a tenant cannot
--     federate into an unrelated workspace.
-- This keeps the feature purely additive: no change to the subscribers RLS,
-- no privileged cross-tenant read path.
--
-- The GUC is read via NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- so an unset GUC does not crash the policy (raw ::uuid cast would). Shape
-- copied from 0450_tenant_custom_field_settings.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS federated_subscriber_map (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Owning (child) tenant — drives RLS isolation.
    tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The child workspace's subscriber row.
    child_subscriber_id  uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- The agency parent workspace and its master subscriber row. NOT a FK to
    -- subscribers (that row lives in a different tenant and RLS would hide it);
    -- the relationship is validated in application code.
    parent_tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    master_subscriber_id uuid        NOT NULL,
    -- Provenance: which identifier matched, and its value at link time.
    match_type           text        NOT NULL DEFAULT 'email',
    match_key            text        NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT federated_subscriber_map_match_type_chk
        CHECK (match_type IN ('email', 'external_id', 'manual'))
);

-- One federation link per (child subscriber, master subscriber). Drives the
-- create-path conflict handling (idempotent re-link is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS federated_subscriber_map_child_master_idx
    ON federated_subscriber_map (tenant_id, child_subscriber_id, master_subscriber_id);

-- Lookup by child subscriber (the GET endpoint's primary access pattern).
CREATE INDEX IF NOT EXISTS federated_subscriber_map_child_idx
    ON federated_subscriber_map (tenant_id, child_subscriber_id);

-- Lookup by parent/master (agency-side roll-up, future use).
CREATE INDEX IF NOT EXISTS federated_subscriber_map_parent_idx
    ON federated_subscriber_map (parent_tenant_id, master_subscriber_id);

CREATE TRIGGER federated_subscriber_map_set_updated_at
    BEFORE UPDATE ON federated_subscriber_map
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON federated_subscriber_map TO postwave_app;

ALTER TABLE federated_subscriber_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE federated_subscriber_map FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON federated_subscriber_map
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
