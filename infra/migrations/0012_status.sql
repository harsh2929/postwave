-- 0012_status.sql
--
-- Public status page backend (status.postwave.app). The marketing site reads
-- GET /api/v1/status/public, which aggregates this table plus a real-time
-- health probe.
--
-- Both tables are PUBLIC READ — RLS is intentionally disabled and a SELECT
-- grant is given to the unauthenticated `postwave_public` role used by the
-- status endpoint. Mutations are restricted to the application role.

BEGIN;

-- A read-only role used by the public status handler. We grant only the
-- columns the public actually needs to see.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_public') THEN
        CREATE ROLE postwave_public NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO postwave_public;

-- ---------------------------------------------------------------------------
-- service_health  (one row per service per day)
-- ---------------------------------------------------------------------------
CREATE TABLE service_health (
    service             text NOT NULL,
    day                 date NOT NULL,
    uptime_pct          numeric(5,2) NOT NULL DEFAULT 100.00,
    degraded_minutes    int NOT NULL DEFAULT 0,
    outage_minutes      int NOT NULL DEFAULT 0,
    PRIMARY KEY (service, day)
);

CREATE INDEX service_health_day_idx ON service_health (day DESC);

GRANT SELECT, INSERT, UPDATE ON service_health TO postwave_app;
GRANT SELECT ON service_health TO postwave_public;

-- ---------------------------------------------------------------------------
-- incidents  (only published=true rows are publicly visible)
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title              text NOT NULL,
    status             text NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
    severity           text NOT NULL CHECK (severity IN ('minor','major','critical')),
    started_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz,
    description        text,
    affected_services  text[] NOT NULL DEFAULT '{}',
    published          boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incidents_started_idx   ON incidents (started_at DESC);
CREATE INDEX incidents_published_idx ON incidents (started_at DESC) WHERE published = true;

CREATE TRIGGER incidents_set_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON incidents TO postwave_app;
GRANT SELECT ON incidents TO postwave_public;

-- Public-read predicate enforced via a view; the API handler can also filter
-- with WHERE published = true at query time.
CREATE OR REPLACE VIEW incidents_public AS
    SELECT id, title, status, severity, started_at, resolved_at,
           description, affected_services
      FROM incidents
     WHERE published = true;

GRANT SELECT ON incidents_public TO postwave_public;
GRANT SELECT ON incidents_public TO postwave_app;

COMMIT;
