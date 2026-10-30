-- 0107_render_cache.sql
--
-- Durable cross-client preview cache for the deliverability service. Rows are
-- keyed by sha256(environment + html) and store only rendered metadata (HCTI
-- image URL, viewport, issues), never the raw campaign HTML.

BEGIN;

CREATE TABLE IF NOT EXISTS render_cache (
    cache_key  text PRIMARY KEY,
    payload    jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS render_cache_expires_at_idx
    ON render_cache (expires_at);

CREATE TRIGGER render_cache_set_updated_at
    BEFORE UPDATE ON render_cache
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON render_cache TO postwave_app;

COMMIT;
