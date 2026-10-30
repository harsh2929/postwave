-- 1839_email_verification.sql
--
-- The verification connector layer (apps/api/internal/verification).
--
-- Context: Postwave deliberately does not run SMTP RCPT-TO probes from its own
-- address space — probing generates bounces attributed to the prober and gets
-- the probing IPs listed on the very DNSBLs the deliverability service
-- monitors. docs/lists-suppressions-2026-gap-analysis.md made that call and
-- recommended integrating a third-party validator instead. This migration is
-- the storage half of finally doing that.
--
-- Four concerns, four tables:
--
--   verification_providers  per-tenant BYO vendor config. Stores only a
--                           opaque tenant-local credential id; the API key
--                           itself lives in the namespaced secrets backend,
--                           never here.
--   verification_cache      verdicts already paid for, with a TTL. This is
--                           what stops a re-import of the same list from
--                           costing a second set of credits.
--   verification_jobs       async bulk runs, with the measured
--                           credits-saved accounting attached.
--   verification_job_items  per-address results for a job.
--
-- Plus verification_usage_daily, the rollup the credits dashboard reads so it
-- never has to scan job_items.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: All five tables are new and additive; no existing code
-- reads them. Dropping them loses cached verdicts (which cost credits to
-- rebuild) and job history, but is otherwise safe.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Provider configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS verification_providers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Matches the Provider* constants in verification.go.
    provider        text NOT NULL,
    -- Opaque tenant-local credential id. The server derives
    -- postwave/tenants/<tenant>/verification/<provider>/<id>; API input never
    -- selects a global vault name. The key itself is NEVER stored in Postgres.
    credential_ref  text NOT NULL,
    enabled         boolean NOT NULL DEFAULT true,
    -- Bounded driver behavior only (ip_address for geo enrichment,
    -- degrade_on_failure, cache_ttl_days). Provider origins are code-owned.
    settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Last observed credit balance + when, so the dashboard can render a
    -- balance without a synchronous vendor call on every page load.
    last_balance     integer,
    last_balance_at  timestamptz,
    -- Last error seen talking to this provider, for the config screen.
    last_error       text NOT NULL DEFAULT '',
    last_error_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT verification_providers_provider_check
        CHECK (provider IN ('zerobounce', 'kickbox')),
    CONSTRAINT verification_providers_credential_ref_check
        CHECK (credential_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
    UNIQUE (tenant_id, provider)
);

-- At most one ENABLED vendor per tenant. Two enabled providers would make
-- "which one billed this address?" unanswerable and would let a mis-click
-- silently double the credit spend.
CREATE UNIQUE INDEX IF NOT EXISTS verification_providers_one_enabled_idx
    ON verification_providers (tenant_id)
    WHERE enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_providers TO postwave_app;

ALTER TABLE verification_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_providers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON verification_providers;
CREATE POLICY tenant_isolation ON verification_providers
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Verdict cache
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS verification_cache (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         text NOT NULL,
    status        text NOT NULL,
    sub_status    text NOT NULL DEFAULT '',
    -- 0-10 vendor quality score; NULL when the provider supplied none.
    score         smallint,
    domain        text NOT NULL DEFAULT '',
    free_email    boolean NOT NULL DEFAULT false,
    role_account  boolean NOT NULL DEFAULT false,
    disposable    boolean NOT NULL DEFAULT false,
    mx_found      boolean NOT NULL DEFAULT false,
    mx_record     text NOT NULL DEFAULT '',
    did_you_mean  text NOT NULL DEFAULT '',
    first_name    text NOT NULL DEFAULT '',
    last_name     text NOT NULL DEFAULT '',
    gender        text NOT NULL DEFAULT '',
    country       text NOT NULL DEFAULT '',
    city          text NOT NULL DEFAULT '',
    provider      text NOT NULL,
    checked_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,

    PRIMARY KEY (tenant_id, email),
    CONSTRAINT verification_cache_status_check
        CHECK (status IN ('valid', 'invalid', 'catch_all', 'spamtrap',
                          'abuse', 'do_not_mail', 'unknown')),
    CONSTRAINT verification_cache_score_check
        CHECK (score IS NULL OR (score >= 0 AND score <= 10))
);

-- Expiry sweep. Partial on the common case so the index stays small.
CREATE INDEX IF NOT EXISTS verification_cache_expiry_idx
    ON verification_cache (expires_at);

-- "How much of my list is invalid?" without a sequential scan.
CREATE INDEX IF NOT EXISTS verification_cache_tenant_status_idx
    ON verification_cache (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_cache TO postwave_app;

ALTER TABLE verification_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_cache FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON verification_cache;
CREATE POLICY tenant_isolation ON verification_cache
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Bulk jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS verification_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'pending',
    -- Where the addresses came from.
    source          text NOT NULL DEFAULT 'inline',
    -- Opaque handle for the source (tag name, segment id, list id).
    source_ref      text NOT NULL DEFAULT '',
    provider        text NOT NULL DEFAULT '',
    total           integer NOT NULL DEFAULT 0,
    processed       integer NOT NULL DEFAULT 0,
    -- The measured chain accounting. Kept on the job (not recomputed)
    -- so the savings figure shown to an operator is the one that
    -- actually happened, not a re-derivation against a mutated cache.
    cache_hits      integer NOT NULL DEFAULT 0,
    local_filtered  integer NOT NULL DEFAULT 0,
    vendor_verified integer NOT NULL DEFAULT 0,
    credits_spent   integer NOT NULL DEFAULT 0,
    duplicates      integer NOT NULL DEFAULT 0,
    error           text NOT NULL DEFAULT '',
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    completed_at    timestamptz,

    CONSTRAINT verification_jobs_status_check
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
    -- Only the sources the worker can actually resolve. Listing
    -- 'segment'/'list' here would let the API accept a job that the
    -- worker would then have to fail — better to reject it at the
    -- boundary until those resolvers exist.
    CONSTRAINT verification_jobs_source_check
        CHECK (source IN ('inline', 'upload', 'tag', 'all_subscribers')),
    CONSTRAINT verification_jobs_counts_check
        CHECK (processed >= 0 AND total >= 0 AND credits_spent >= 0)
);

CREATE INDEX IF NOT EXISTS verification_jobs_tenant_created_idx
    ON verification_jobs (tenant_id, created_at DESC);

-- Claim index for the worker: only rows it can actually pick up.
CREATE INDEX IF NOT EXISTS verification_jobs_claimable_idx
    ON verification_jobs (created_at)
    WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_jobs TO postwave_app;

ALTER TABLE verification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON verification_jobs;
CREATE POLICY tenant_isolation ON verification_jobs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Composite-FK target for verification_job_items below. Must exist BEFORE
-- the referencing table is created: Postgres resolves an FK against an
-- existing unique constraint at CREATE TABLE time, not at COMMIT.
ALTER TABLE verification_jobs
    ADD CONSTRAINT verification_jobs_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE IF NOT EXISTS verification_job_items (
    id          bigserial PRIMARY KEY,
    job_id      uuid NOT NULL,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       text NOT NULL,
    -- Rows are inserted UNVERIFIED (processed = false) when the job is
    -- created, then updated in place as the worker gets to them. That
    -- makes the queue durable: a worker crash mid-job resumes from the
    -- unprocessed rows instead of re-verifying — and re-paying for —
    -- everything already done.
    processed   boolean NOT NULL DEFAULT false,
    status      text NOT NULL DEFAULT 'unknown',
    sub_status  text NOT NULL DEFAULT '',
    score       smallint,
    provider    text NOT NULL DEFAULT '',
    billable    boolean NOT NULL DEFAULT false,
    cached      boolean NOT NULL DEFAULT false,
    did_you_mean text NOT NULL DEFAULT '',
    checked_at  timestamptz,

    -- Tenant-scoped composite FK: a bare REFERENCES verification_jobs(id)
    -- is checked with RLS bypassed, so it would only prove the job exists
    -- GLOBALLY and would let one tenant attach items to another tenant's
    -- job. Mirrors the pattern established in migration 1759.
    CONSTRAINT verification_job_items_job_fkey
        FOREIGN KEY (tenant_id, job_id)
        REFERENCES verification_jobs (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT verification_job_items_status_check
        CHECK (status IN ('valid', 'invalid', 'catch_all', 'spamtrap',
                          'abuse', 'do_not_mail', 'unknown')),
    CONSTRAINT verification_job_items_score_check
        CHECK (score IS NULL OR (score >= 0 AND score <= 10))
);

CREATE INDEX IF NOT EXISTS verification_job_items_job_idx
    ON verification_job_items (job_id, status);

CREATE INDEX IF NOT EXISTS verification_job_items_tenant_idx
    ON verification_job_items (tenant_id, job_id);

-- The worker's claim query. Partial so it holds only the work that is
-- actually outstanding rather than every result ever produced.
CREATE INDEX IF NOT EXISTS verification_job_items_pending_idx
    ON verification_job_items (job_id, id)
    WHERE NOT processed;

-- One row per address per job. Without this a retried creation would
-- silently double the job's cost.
CREATE UNIQUE INDEX IF NOT EXISTS verification_job_items_unique_idx
    ON verification_job_items (job_id, email);

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_job_items TO postwave_app;
-- bigserial creates a sequence with its own privilege set; the table
-- grant above does not cover it, and without this every insert fails
-- with "permission denied for sequence".
GRANT USAGE, SELECT ON SEQUENCE verification_job_items_id_seq TO postwave_app;

ALTER TABLE verification_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_job_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON verification_job_items;
CREATE POLICY tenant_isolation ON verification_job_items
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Daily usage rollup
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS verification_usage_daily (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    day             date NOT NULL,
    provider        text NOT NULL DEFAULT '',
    verified        integer NOT NULL DEFAULT 0,
    credits_spent   integer NOT NULL DEFAULT 0,
    local_filtered  integer NOT NULL DEFAULT 0,
    cache_hits      integer NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, day, provider)
);

GRANT SELECT, INSERT, UPDATE ON verification_usage_daily TO postwave_app;

ALTER TABLE verification_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_usage_daily FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON verification_usage_daily;
CREATE POLICY tenant_isolation ON verification_usage_daily
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
