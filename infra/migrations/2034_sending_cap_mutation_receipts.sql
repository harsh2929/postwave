-- 2034_sending_cap_mutation_receipts.sql
--
-- Exact, non-secret commit receipts for the cross-replica sending-cap
-- mutation protocol. PostgreSQL COMMIT can fail at the client after the
-- server accepted it; the gateway must distinguish that outcome before it
-- finalizes or aborts the Redis fence. The random mutation token itself never
-- enters durable storage: only its SHA-256 correlation digest is retained.
--
-- rollback-strategy: no-op. These rows are commit-outcome evidence. Keep the
-- table across an application rollback so an older/newer mixed fleet cannot
-- lose the only exact proof for an ambiguous mutation.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE tenant_sending_cap_mutation_receipts (
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mutation_sha256        text NOT NULL CHECK (mutation_sha256 ~ '^[0-9a-f]{64}$'),
    -- Evidence must accept the exact pre-existing durable integer domain.
    -- Current writes validate 1..1,000,000 or NULL, but legacy rows can contain
    -- zero/negative or larger values; a receipt constraint must never turn an
    -- otherwise valid clear/remediation into a permanent rollback.
    committed_cap          integer,
    settings_updated_at    timestamptz NOT NULL,
    recorded_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, mutation_sha256)
);

ALTER TABLE tenant_sending_cap_mutation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sending_cap_mutation_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_sending_cap_mutation_receipts_tenant
    ON tenant_sending_cap_mutation_receipts
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON tenant_sending_cap_mutation_receipts TO postwave_app;

COMMIT;
