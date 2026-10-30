-- 0250_list_metadata_extension.sql
--
-- GAP-LS-056 / GAP-LS-057 / GAP-LS-063 / GAP-LS-067 / GAP-LS-068 /
-- GAP-LS-116: Postwave-side metadata attached to Listmonk lists +
-- per-subscriber lifecycle stage.
--
-- Listmonk lists carry id (bigint) + name + type + tags upstream.
-- Postwave needs to attach data Listmonk doesn't model — archive
-- state, per-source growth attribution, custom metadata, and
-- created/updated timestamps for the lists table sort UX (GAP-LS-116).
-- Rather than add columns to a Listmonk-managed table we attach a
-- sidecar keyed by listmonk_list_id (bigint).
--
-- subscriber_lifecycle is the HubSpot-parity stage column (GAP-LS-068)
-- and contact rating (GAP-LS-067) for the per-subscriber view +
-- segment predicates. Kept as a sidecar so the subscribers table
-- doesn't widen further.

BEGIN;

CREATE TABLE IF NOT EXISTS list_metadata (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    listmonk_list_id    bigint NOT NULL,
    archived_at         timestamptz,
    archived_by         uuid,
    growth_sources      jsonb NOT NULL DEFAULT '{}'::jsonb,
    tags                text[] NOT NULL DEFAULT '{}'::text[],
    custom_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, listmonk_list_id)
);

CREATE INDEX IF NOT EXISTS list_metadata_tenant_archived_idx
    ON list_metadata (tenant_id, archived_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS list_metadata_tenant_updated_idx
    ON list_metadata (tenant_id, updated_at DESC);

CREATE TRIGGER list_metadata_set_updated_at
    BEFORE UPDATE ON list_metadata
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON list_metadata TO postwave_app;

ALTER TABLE list_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_metadata FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON list_metadata
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON list_metadata
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- subscriber_lifecycle: HubSpot-style stage + contact rating sidecar.
-- One row per subscriber (PK on subscriber_id keeps the join cheap).
CREATE TABLE IF NOT EXISTS subscriber_lifecycle (
    subscriber_id   uuid PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    stage           text NOT NULL DEFAULT 'subscriber'
                    CHECK (stage IN (
                        'subscriber','lead','mql','sql','opportunity',
                        'customer','evangelist','other'
                    )),
    score           smallint NOT NULL DEFAULT 3
                    CHECK (score BETWEEN 1 AND 5),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriber_lifecycle_tenant_stage_idx
    ON subscriber_lifecycle (tenant_id, stage);

CREATE INDEX IF NOT EXISTS subscriber_lifecycle_tenant_score_idx
    ON subscriber_lifecycle (tenant_id, score DESC);

CREATE TRIGGER subscriber_lifecycle_set_updated_at
    BEFORE UPDATE ON subscriber_lifecycle
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_lifecycle TO postwave_app;

ALTER TABLE subscriber_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_lifecycle FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_lifecycle
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_lifecycle
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
