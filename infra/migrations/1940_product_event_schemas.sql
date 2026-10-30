-- 1940_product_event_schemas.sql
--
-- Declared event schemas: what an event is SUPPOSED to look like.
--
-- The observed half already exists. `product_event_property_types` records the
-- first type each property arrived as and counts contradictions, which closed
-- the no-signal gap: a `value` that is "10" on Monday and 10 on Tuesday is now
-- countable. What it cannot do is say which one was RIGHT. Observation can only
-- report that a shape changed; it has no opinion, so the first arrival wins by
-- accident of ordering and a schema that was wrong from the start looks stable.
--
-- This is the half that lets somebody state the intent up front.
--
-- VERSIONED, because an event's shape legitimately changes and the alternative
-- is editing history. A new version is a new row; the old one stays readable so
-- events collected under it can still be explained. `active` marks the one new
-- events are checked against — exactly one per (tenant, event_name), enforced by
-- a partial unique index rather than by application code remembering to clear
-- the previous flag.
--
-- IT DOES NOT REJECT, and that is the same decision the observed half already
-- made and for the same reason: a property whose type moved is still a usable
-- event, and dropping real customer data because an app shipped a change is
-- worse than the drift. Violations are counted on the schema row so somebody can
-- see the app and the declaration disagreeing, and decide which to fix.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS product_event_schemas (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_name    text NOT NULL,
    version       integer NOT NULL CHECK (version > 0),
    -- {property_name: json_type}, using JSON's own vocabulary — the same five
    -- names product_event_property_types records, so a declaration and an
    -- observation can be compared without translating between two spellings.
    properties    jsonb NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(properties) = 'object'),
    -- Properties an event MUST carry. Separate from `properties` because
    -- "declared and optional" and "declared and required" are different claims,
    -- and folding them would make every declared property mandatory the moment
    -- somebody documented it.
    required      text[] NOT NULL DEFAULT '{}'::text[],
    active        boolean NOT NULL DEFAULT true,
    -- Counted, not logged per-event: a busy tenant with a drifting app would
    -- otherwise generate a row per event, and the question being asked is "is
    -- this declaration still true", which a count answers.
    violation_count      bigint NOT NULL DEFAULT 0 CHECK (violation_count >= 0),
    last_violation_at    timestamptz,
    last_violation_detail text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, event_name, version)
);

-- Exactly one active version per event, enforced here rather than in the
-- handler. An application-side "clear the old flag first" is a rule somebody
-- forgets under a race, and two active versions means an event validates
-- against whichever row the planner returned.
CREATE UNIQUE INDEX IF NOT EXISTS product_event_schemas_active_uniq
    ON product_event_schemas (tenant_id, event_name)
    WHERE active;

CREATE INDEX IF NOT EXISTS product_event_schemas_tenant_idx
    ON product_event_schemas (tenant_id, event_name);

ALTER TABLE product_event_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_event_schemas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON product_event_schemas;
CREATE POLICY tenant_isolation ON product_event_schemas
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON product_event_schemas;
CREATE POLICY tenant_visible ON product_event_schemas
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON product_event_schemas TO postwave_app;

COMMENT ON TABLE product_event_schemas IS
    'Declared event shapes. The observed half (product_event_property_types) '
    'reports that a shape changed; this says which shape was intended. Never '
    'rejects an event — violations are counted so the app and the declaration '
    'can be seen disagreeing.';

COMMIT;
