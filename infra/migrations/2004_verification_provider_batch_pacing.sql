-- 2004_verification_provider_batch_pacing.sql
--
-- ZeroBounce limits real-time validatebatch traffic to 30 requests/minute.
-- This tenant/provider row is the multi-replica reservation clock used by both
-- synchronous API calls and durable verification jobs. A reservation may be
-- abandoned when its request context or job lease expires; wasting a slot is
-- safe, while reusing it could exceed the upstream account limit.
--
-- migration-execution: transactional
-- rollback-strategy: expand-contract
-- rollback-details: Keep the table while any application process reserves
-- batch slots. It contains no addresses, credentials, or provider responses.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE verification_provider_batch_slots (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    next_dispatch_at timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, provider),
    CONSTRAINT verification_provider_batch_slots_provider_check
        CHECK (provider = 'zerobounce')
);

COMMENT ON TABLE verification_provider_batch_slots IS
    'Tenant/provider-wide durable validatebatch reservation clock; contains no recipient or credential data.';

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_provider_batch_slots TO postwave_app;

ALTER TABLE verification_provider_batch_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_provider_batch_slots FORCE ROW LEVEL SECURITY;

CREATE POLICY verification_provider_batch_slots_tenant
    ON verification_provider_batch_slots
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
