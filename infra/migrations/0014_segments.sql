-- 0014_segments.sql
--
-- Saved tenant segments. The query_ast column stores a canonical SegmentNode
-- AST (defined in packages/schema/src/index.ts) which the API gateway
-- compiles to SQL via the existing translator at
-- services/migration/internal/translator/listmonk/segment.go for
-- previews + Listmonk hand-off.
--
-- last_count + last_evaluated_at are denormalised summaries refreshed by
-- /api/v1/segments/preview (synchronous) and a future cron evaluator.

BEGIN;

CREATE TABLE segments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name              text NOT NULL,
    description       text NOT NULL DEFAULT '',
    query_ast         jsonb NOT NULL,
    last_count        integer,
    last_evaluated_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX segments_tenant_idx ON segments (tenant_id, updated_at DESC);
CREATE UNIQUE INDEX segments_tenant_id_idx ON segments (tenant_id, id);

CREATE TRIGGER segments_set_updated_at
    BEFORE UPDATE ON segments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON segments TO postwave_app;

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON segments
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
