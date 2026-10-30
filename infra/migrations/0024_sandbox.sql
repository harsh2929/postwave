-- 0024_sandbox.sql
--
-- Sandbox mode primitives. API keys can be flagged sandbox_only so that all
-- send operations are intercepted, audited, and replayed as deterministic
-- fake lifecycle events in the sandbox_events queue. The flusher goroutine
-- in apps/api/main.go promotes due rows into subscriber_events so the rest
-- of the system experiences a sandbox campaign as if it were real.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

ALTER TABLE api_keys
    ADD COLUMN sandbox_only bool NOT NULL DEFAULT false;

CREATE TABLE sandbox_events (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id       uuid,
    subscriber_email  citext,
    event_type        text NOT NULL,
    at                timestamptz NOT NULL,
    delivered         bool NOT NULL DEFAULT false
);

CREATE INDEX sandbox_events_tenant_at_idx
    ON sandbox_events (tenant_id, at);

CREATE INDEX sandbox_events_due_idx
    ON sandbox_events (delivered, at)
    WHERE delivered = false;

GRANT SELECT, INSERT, UPDATE, DELETE ON sandbox_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE sandbox_events_id_seq TO postwave_app;

ALTER TABLE sandbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sandbox_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive policy used by the background flusher, which has no tenant
-- context (it sweeps every tenant's due events on a single connection).
CREATE POLICY sandbox_events_flusher ON sandbox_events
    AS PERMISSIVE
    FOR ALL
    USING (true)
    WITH CHECK (true);

COMMIT;
