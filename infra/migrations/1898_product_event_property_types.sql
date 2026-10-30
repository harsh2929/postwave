-- 1898_product_event_property_types.sql
--
-- The observed shape of every product event's properties.
--
-- `GET /api/v1/track/catalog` reads like a schema registry and is a
-- `GROUP BY event_name` over whatever arrived. It reports event NAMES and
-- nothing about their contents, so the failure that actually breaks
-- segmentation is invisible: a `value` that arrives as "10" on Monday and 10 on
-- Tuesday. A numeric comparison silently stops matching the string rows, a
-- revenue sum quietly drops them, and nothing anywhere says the shape changed.
--
-- This records the FIRST type seen for each property and counts every later
-- contradiction. First-seen rather than most-common on purpose: "this changed"
-- is the useful statement, and a most-common baseline moves under you — once
-- enough bad rows arrive the baseline becomes the bad type and the drift
-- disappears from the report exactly when it has done the most damage.
--
-- IT DOES NOT REFUSE. An event name that breaks the naming contract is
-- unaddressable and is rightly rejected at both boundaries (see 1896-era work
-- on `track.ValidEventName`); a property whose type moved is still a usable
-- event, and refusing it would drop real customer data because an app shipped a
-- change. The gap this closes is that there was NO SIGNAL, not that the write
-- should have failed.
--
-- NULL IS NOT A TYPE. A property arriving as null establishes nothing: if null
-- pinned the type, every subsequent real value would be reported as drift, and
-- the report would be loudest about the events with the least wrong with them.
-- Nulls are skipped entirely.

BEGIN;

CREATE TABLE IF NOT EXISTS product_event_property_types (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_name  text        NOT NULL,
    property    text        NOT NULL,
    -- The JSON type first seen for this property. JSON has ONE number type, so
    -- 10 and 10.5 are both `number` — splitting them would report ordinary data
    -- as drift on the first decimal.
    json_type   text        NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    -- How many times a DIFFERENT type arrived for this property, and what the
    -- most recent one was. A count rather than a row per conflict: the question
    -- is "did this change and how often", and one row per event would put the
    -- volume of the event log into a table meant to summarise it.
    conflict_count     bigint      NOT NULL DEFAULT 0,
    last_conflict_type text        NOT NULL DEFAULT '',
    last_conflict_at   timestamptz,
    PRIMARY KEY (tenant_id, event_name, property),
    CONSTRAINT product_event_property_types_json_type_check
        CHECK (json_type = ANY (ARRAY['string', 'number', 'boolean', 'object', 'array'])),
    -- The conflict type is either empty or one of the same vocabulary. Written
    -- as a CHECK so a typo in the recorder cannot quietly populate the report
    -- with a word no client knows how to render.
    CONSTRAINT product_event_property_types_conflict_type_check
        CHECK (last_conflict_type = ''
               OR last_conflict_type = ANY (ARRAY['string', 'number', 'boolean', 'object', 'array'])),
    CONSTRAINT product_event_property_types_property_len
        CHECK (char_length(property) BETWEEN 1 AND 256)
);

COMMENT ON TABLE product_event_property_types IS
    'First-seen JSON type per (event, property), with a count of later '
    'contradictions. The catalog reports which events exist; this reports '
    'whether their shape has been stable, which is what breaks segmentation.';

-- The report reads "which properties on my events have drifted", so the index
-- is on the tenant and the conflict count rather than on the primary key order.
CREATE INDEX IF NOT EXISTS product_event_property_types_conflicts_idx
    ON product_event_property_types (tenant_id, conflict_count DESC)
    WHERE conflict_count > 0;

ALTER TABLE product_event_property_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_event_property_types FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON product_event_property_types;
CREATE POLICY tenant_isolation ON product_event_property_types
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON product_event_property_types;
CREATE POLICY tenant_visible ON product_event_property_types
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

-- UPDATE is granted here, unlike on product_events.
--
-- product_events is an append-only log and its grant is deliberately narrow so
-- the application cannot rewrite history. This table is the opposite kind of
-- thing: a running summary whose whole purpose is to be updated in place as
-- each event arrives. One row per observation would reproduce the event log at
-- the size of the event log.
GRANT SELECT, INSERT, UPDATE ON product_event_property_types TO postwave_app;

COMMIT;
