-- 1978_frequency_caps_missing_tables.sql
--
-- `internal/freq_caps` queries TWO TABLES THAT NO MIGRATION EVER CREATED:
-- `frequency_caps` and `frequency_cap_events`. Migration 0260 created
-- `frequency_cap_rules`, which is a DIFFERENT model owned by
-- `internal/frequency` and served at /api/v1/sending/frequency-caps.
--
-- THIS WAS NOT A BROKEN SCREEN. `freq_caps.WouldDefer` is called from the send
-- path -- internal/campaigns/automation_email.go:150 -- and that caller does:
--
--     decision, err := freq_caps.WouldDefer(...)
--     if err != nil { return err }
--
-- so `ERROR: relation "frequency_caps" does not exist` turned EVERY automation
-- email send into an error. The comment at that call site reads "internal/
-- freq_caps had ZERO send-time callsites -- it was a configurable surface wired
-- to nothing. This is one." It was wired to a schema that never shipped.
--
-- It went unnoticed because every test in that package was a pure unit test of
-- ValidateCap: nothing ever executed the SQL. `would_defer_db_test.go` now does.
--
-- WHY CREATE THE TABLES RATHER THAN REPOINT THE CODE AT frequency_cap_rules.
-- The two models are not the same feature and one cannot be expressed in the
-- other. `frequency_cap_rules` is (max_sends, window_hours, channels[]) with no
-- notion of message type or audience. `freq_caps` is (channel, message_type,
-- max_count, window_seconds, applies_to) and its counter is a per-send EVENT
-- LOG, which is what makes a rolling window enforceable at send time.
-- Collapsing them would silently change which sends are held back; the two
-- surfaces stay distinct and this migration gives the enforcing one its schema.

BEGIN;

-- 1. The rules the send loop reads -------------------------------------------
CREATE TABLE IF NOT EXISTS frequency_caps (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label          text        NOT NULL DEFAULT '',
    -- '*' means "any channel". ValidateCap restricts the concrete values.
    channel        text        NOT NULL,
    message_type   text        NOT NULL,
    max_count      int         NOT NULL CHECK (max_count > 0),
    -- Seconds, not hours: WouldDefer builds its cutoff in seconds, and storing
    -- hours here would make every window a lossy round-trip.
    window_seconds int         NOT NULL CHECK (window_seconds BETWEEN 1 AND 2592000),
    applies_to     text        NOT NULL DEFAULT 'all',
    active         boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- listActiveMatchingCaps filters on (tenant, active) then matches channel and
-- message_type in Go, so the partial index carries the whole predicate it uses.
CREATE INDEX IF NOT EXISTS frequency_caps_tenant_active_idx
    ON frequency_caps (tenant_id)
    WHERE active;

GRANT SELECT, INSERT, UPDATE, DELETE ON frequency_caps TO postwave_app;

ALTER TABLE frequency_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE frequency_caps FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON frequency_caps
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON frequency_caps
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. The per-send event log the rolling window counts ------------------------
--    Append-only by intent: RecordSent only ever INSERTs, and the count(*) in
--    WouldDefer is the enforcement. There is no UPDATE path, so a cap can never
--    be silently relaxed by rewriting history.
CREATE TABLE IF NOT EXISTS frequency_cap_events (
    id               bigserial   PRIMARY KEY,
    tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email text        NOT NULL,
    channel          text        NOT NULL,
    message_type     text        NOT NULL,
    -- Nullable: an automation send has no campaign. RecordSent passes
    -- NULLIF($5,'')::uuid for exactly that case.
    campaign_id      uuid        REFERENCES campaigns(id) ON DELETE SET NULL,
    sent_at          timestamptz NOT NULL DEFAULT now()
);

-- The counting query is (tenant, subscriber_email, sent_at >= cutoff) with
-- channel/message_type as equality-or-wildcard, so lead with the three columns
-- it always constrains and let the window be a range scan.
CREATE INDEX IF NOT EXISTS frequency_cap_events_window_idx
    ON frequency_cap_events (tenant_id, subscriber_email, sent_at DESC);

GRANT SELECT, INSERT, DELETE ON frequency_cap_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE frequency_cap_events_id_seq TO postwave_app;

ALTER TABLE frequency_cap_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE frequency_cap_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON frequency_cap_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON frequency_cap_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
