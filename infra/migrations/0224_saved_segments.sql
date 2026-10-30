-- 0224_saved_segments.sql
--
-- Mailchimp-parity "Saved segments" tab. The desktop dashboard lets
-- operators capture the current filter set on the Subscribers page
-- under a name and reload it later. predicate_json is the raw filter
-- payload (compatible with whatever the segment-builder uses) — we
-- don't enforce a Go-side type so a future filter-shape evolution
-- doesn't require a migration.
--
-- Distinct from the existing `segments` table which is the full
-- segment AST + evaluation surface. saved_segments is the
-- lightweight bookmark.

BEGIN;

CREATE TABLE saved_segments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,
    description     text NOT NULL DEFAULT '',
    predicate_json  jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_run_at     timestamptz,
    UNIQUE (tenant_id, name)
);

CREATE INDEX saved_segments_tenant_idx
    ON saved_segments (tenant_id, updated_at DESC);

CREATE TRIGGER saved_segments_set_updated_at
    BEFORE UPDATE ON saved_segments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_segments TO postwave_app;

ALTER TABLE saved_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_segments FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_segments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON saved_segments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
