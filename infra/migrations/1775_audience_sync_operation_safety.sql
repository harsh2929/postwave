-- 1775_audience_sync_operation_safety.sql
--
-- Durable operation identity and mutual exclusion for webhook and native
-- ad-audience activation.  Previous releases created audience_sync_runs only
-- for audience_syncs and created audience_sync_jobs *after* the separate
-- audience_destinations provider call.  Scheduled audience_syncs were also a
-- read-only due scan, so two worker replicas could execute the same resource.
--
-- This additive migration gives both resource families:
--   * a short renewable lease on the mutable definition row;
--   * a tenant/resource-scoped operation key on the pre-effect ledger;
--   * honest source-cap evidence; and
--   * append-only request-attempt evidence whose hash can prove exactly which
--     bounded payload was attempted without storing member PII again.
--
-- rollback-strategy: expand-contract - older releases ignore all added
-- columns/tables.  The widened status constraints remain backward compatible
-- with their running/succeeded/failed writes.

BEGIN;

ALTER TABLE audience_syncs
    ADD COLUMN IF NOT EXISTS run_lease_owner uuid,
    ADD COLUMN IF NOT EXISTS run_lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS run_lease_operation_key text;

ALTER TABLE audience_destinations
    ADD COLUMN IF NOT EXISTS sync_lease_owner uuid,
    ADD COLUMN IF NOT EXISTS sync_lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS sync_lease_operation_key text;

ALTER TABLE audience_sync_runs
    ADD COLUMN IF NOT EXISTS operation_key text,
    ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS source_members_observed integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cap_exceeded boolean NOT NULL DEFAULT false;

ALTER TABLE audience_sync_jobs
    ADD COLUMN IF NOT EXISTS operation_key text,
    ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS source_members_observed integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cap_exceeded boolean NOT NULL DEFAULT false;

ALTER TABLE audience_sync_runs
    DROP CONSTRAINT IF EXISTS audience_sync_runs_status_check;
ALTER TABLE audience_sync_runs
    ADD CONSTRAINT audience_sync_runs_status_check
    CHECK (status IN (
        'running','succeeded','failed','rejected','partial','needs_reconciliation'
    ));

ALTER TABLE audience_sync_jobs
    DROP CONSTRAINT IF EXISTS audience_sync_jobs_status_check;
ALTER TABLE audience_sync_jobs
    ADD CONSTRAINT audience_sync_jobs_status_check
    CHECK (status IN (
        'queued','running','succeeded','failed','rejected','partial','needs_reconciliation'
    ));

ALTER TABLE audience_sync_runs
    DROP CONSTRAINT IF EXISTS audience_sync_runs_trigger_kind_check;
ALTER TABLE audience_sync_runs
    ADD CONSTRAINT audience_sync_runs_trigger_kind_check
    CHECK (trigger_kind IN ('manual','scheduled'));

ALTER TABLE audience_sync_jobs
    DROP CONSTRAINT IF EXISTS audience_sync_jobs_trigger_kind_check;
ALTER TABLE audience_sync_jobs
    ADD CONSTRAINT audience_sync_jobs_trigger_kind_check
    CHECK (trigger_kind IN ('manual','scheduled'));

ALTER TABLE audience_sync_runs
    DROP CONSTRAINT IF EXISTS audience_sync_runs_source_members_observed_check;
ALTER TABLE audience_sync_runs
    ADD CONSTRAINT audience_sync_runs_source_members_observed_check
    CHECK (source_members_observed >= 0);

ALTER TABLE audience_sync_jobs
    DROP CONSTRAINT IF EXISTS audience_sync_jobs_source_members_observed_check;
ALTER TABLE audience_sync_jobs
    ADD CONSTRAINT audience_sync_jobs_source_members_observed_check
    CHECK (source_members_observed >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS audience_sync_runs_operation_key_uidx
    ON audience_sync_runs (tenant_id, sync_id, operation_key)
    WHERE operation_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audience_sync_jobs_operation_key_uidx
    ON audience_sync_jobs (tenant_id, destination_id, operation_key)
    WHERE operation_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audience_sync_runs_tenant_id_uidx
    ON audience_sync_runs (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS audience_sync_jobs_tenant_id_uidx
    ON audience_sync_jobs (tenant_id, id);

CREATE INDEX IF NOT EXISTS audience_syncs_run_lease_idx
    ON audience_syncs (run_lease_expires_at)
    WHERE run_lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS audience_destinations_sync_lease_idx
    ON audience_destinations (sync_lease_expires_at)
    WHERE sync_lease_expires_at IS NOT NULL;

-- The scheduler claims due definitions cross-tenant, then re-enters tenant
-- scope before creating/executing the operation.  UPDATE is limited to the
-- same worker GUC already used by the discovery policy.
DROP POLICY IF EXISTS audience_syncs_worker_update ON audience_syncs;
CREATE POLICY audience_syncs_worker_update ON audience_syncs
    AS PERMISSIVE FOR UPDATE
    TO postwave_app
    USING (COALESCE(current_setting('app.outbox_worker', true), '') = 'true')
    WITH CHECK (COALESCE(current_setting('app.outbox_worker', true), '') = 'true');

CREATE TABLE IF NOT EXISTS audience_sync_run_attempts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id            uuid NOT NULL,
    sequence          integer NOT NULL CHECK (sequence > 0),
    attempt_kind      text NOT NULL CHECK (attempt_kind IN ('webhook_batch','provider_operation')),
    idempotency_key   text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    payload_sha256    text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    row_count         integer NOT NULL CHECK (row_count >= 0),
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','delivering','acknowledged','ambiguous')),
    attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error        text,
    started_at        timestamptz,
    acknowledged_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, run_id)
        REFERENCES audience_sync_runs (tenant_id, id) ON DELETE CASCADE,
    UNIQUE (tenant_id, run_id, sequence),
    UNIQUE (tenant_id, run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS audience_sync_run_attempts_run_idx
    ON audience_sync_run_attempts (tenant_id, run_id, sequence);

GRANT SELECT, INSERT, UPDATE ON audience_sync_run_attempts TO postwave_app;

ALTER TABLE audience_sync_run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_sync_run_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audience_sync_run_attempts;
CREATE POLICY tenant_isolation ON audience_sync_run_attempts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON audience_sync_run_attempts;
CREATE POLICY tenant_visible ON audience_sync_run_attempts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS audience_sync_job_attempts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    job_id            uuid NOT NULL,
    sequence          integer NOT NULL CHECK (sequence > 0),
    attempt_kind      text NOT NULL DEFAULT 'provider_operation'
                      CHECK (attempt_kind IN ('provider_operation')),
    idempotency_key   text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    payload_sha256    text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    row_count         integer NOT NULL CHECK (row_count >= 0),
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','delivering','acknowledged','ambiguous')),
    attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error        text,
    started_at        timestamptz,
    acknowledged_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, job_id)
        REFERENCES audience_sync_jobs (tenant_id, id) ON DELETE CASCADE,
    UNIQUE (tenant_id, job_id, sequence),
    UNIQUE (tenant_id, job_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS audience_sync_job_attempts_job_idx
    ON audience_sync_job_attempts (tenant_id, job_id, sequence);

GRANT SELECT, INSERT, UPDATE ON audience_sync_job_attempts TO postwave_app;

ALTER TABLE audience_sync_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_sync_job_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audience_sync_job_attempts;
CREATE POLICY tenant_isolation ON audience_sync_job_attempts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON audience_sync_job_attempts;
CREATE POLICY tenant_visible ON audience_sync_job_attempts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON COLUMN audience_sync_runs.operation_key IS
    'Tenant/resource-scoped, server-normalized idempotency identity. Replays observe this operation instead of repeating external effects.';
COMMENT ON COLUMN audience_sync_jobs.operation_key IS
    'Tenant/resource-scoped, server-normalized idempotency identity. Persisted before any provider effect.';
COMMENT ON COLUMN audience_sync_runs.source_members_observed IS
    'Number of source rows observed during bounded preflight; 50001 with cap_exceeded=true means at least 50001.';
COMMENT ON COLUMN audience_sync_jobs.source_members_observed IS
    'Number of source rows observed during bounded preflight; 50001 with cap_exceeded=true means at least 50001.';
COMMENT ON TABLE audience_sync_run_attempts IS
    'Pre-effect request descriptors and acknowledgement state for audience_sync_runs; payload hashes avoid duplicating member PII.';
COMMENT ON TABLE audience_sync_job_attempts IS
    'Pre-effect provider request descriptors and acknowledgement state for audience_sync_jobs; payload hashes avoid duplicating member PII.';

COMMIT;
