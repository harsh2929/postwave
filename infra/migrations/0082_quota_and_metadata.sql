-- 0082_quota_and_metadata.sql
--
-- Two unrelated bits of state, bundled because both are tiny and both
-- come from the same correctness/observability pass:
--
--   1. tenant_ai_usage  — per-tenant, per-day, per-kind LLM call counter
--      that backs the voice service's quota.PostgresQuota implementation.
--      The voice service was previously running without any per-tenant
--      cap; a free tenant could spend arbitrary Anthropic budget.
--
--   2. tenants.metadata — jsonb side-bag for tenant-scoped state that
--      doesn't deserve its own column. The first consumer is the sample-
--      data seeder (apps/api/internal/onboarding/sample_data.go) which
--      previously tracked "already seeded" in an in-memory map — wiped
--      on restart, so a brand-new pod re-seeded the tenant.
--
-- Both pieces follow the canonical RLS pattern from 0079: PERMISSIVE FOR
-- ALL TO postwave_app gated on app.tenant_id. NOT a RESTRICTIVE-only
-- policy — that was the always-deny bug 0079 was written to fix.
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS so re-running the
-- migration in a partial-state environment is safe.

BEGIN;

-- ---------------------------------------------------------------------------
-- tenant_ai_usage
-- ---------------------------------------------------------------------------
-- Composite PK (tenant_id, day, kind) keeps the row count bounded:
-- one tenant × one day × N kinds. UPSERTs keep the +1 atomic; the
-- daily reset is implicit (a new `day` value mints a fresh row).
CREATE TABLE IF NOT EXISTS tenant_ai_usage (
    tenant_id  uuid        NOT NULL,
    day        date        NOT NULL,
    kind       text        NOT NULL,
    count      int         NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, day, kind)
);

-- Range scan helper for "what's this tenant used today?" queries the
-- quota check runs every LLM call.
CREATE INDEX IF NOT EXISTS tenant_ai_usage_tenant_day_idx
    ON tenant_ai_usage (tenant_id, day);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_ai_usage TO postwave_app;

ALTER TABLE tenant_ai_usage ENABLE ROW LEVEL SECURITY;

-- Drop-then-create so re-running the migration doesn't trip "policy
-- already exists". Postgres has no CREATE POLICY IF NOT EXISTS as of 16.
DROP POLICY IF EXISTS tenant_visible ON tenant_ai_usage;
CREATE POLICY tenant_visible ON tenant_ai_usage
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- tenants.metadata
-- ---------------------------------------------------------------------------
-- Free-form jsonb sidecar. Today the sample-data seeder writes:
--   metadata.sample_data_seeded_at : timestamptz string
--   metadata.sample_data_counts    : { subscribers, lists, segments, … }
-- Future consumers can add their own keys without a schema change.
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
