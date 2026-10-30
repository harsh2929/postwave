-- 0021_idempotency.sql
--
-- Replayable response cache keyed by (tenant_id, Idempotency-Key). Stores the
-- exact response bytes + status so duplicate POSTs return byte-identical
-- replies. A janitor goroutine sweeps expired rows hourly.

BEGIN;

CREATE TABLE idempotency_records (
    key             text        NOT NULL,
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    route           text        NOT NULL,
    request_hash    text        NOT NULL,
    response_status int,
    response_body   bytea,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, key)
);

CREATE INDEX idempotency_records_expires_idx
    ON idempotency_records (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_records TO postwave_app;

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON idempotency_records
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive policy for the janitor sweeper, which runs without a tenant
-- context and only ever DELETEs by expires_at.
CREATE POLICY idempotency_sweeper ON idempotency_records
    AS PERMISSIVE
    FOR DELETE
    USING (expires_at < now());

COMMIT;
