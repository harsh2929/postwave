-- 0001_init_tenants.sql
--
-- Bootstraps the multi-tenant core: tenants + users tables, the
-- `set_updated_at` trigger, and Row-Level Security policies that scope every
-- read/write to the tenant id stashed in the per-transaction setting
-- `app.tenant_id`.
--
-- WHY RLS + FORCE: the API connects as `postwave_app`, not as the table
-- owner. We still FORCE row level security so that even a maintenance
-- session that happens to use the owner role cannot accidentally bypass
-- isolation. Every per-tenant query MUST first run
-- `SET LOCAL app.tenant_id = '<uuid>'` inside its transaction.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- updated_at trigger function (shared across all migrations)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                     text UNIQUE NOT NULL,
    name                     text NOT NULL,
    tier                     text NOT NULL CHECK (tier IN ('studio', 'sending', 'pro')),
    stripe_customer_id       text,
    stripe_subscription_id   text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenants_set_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    clerk_user_id   text UNIQUE NOT NULL,
    email           text NOT NULL,
    role            text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_tenant_id_idx ON users (tenant_id);

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- The API process logs in as `postwave_app`. It is NOT a superuser and does
-- not own these tables, so RLS applies to it normally. We additionally use
-- FORCE ROW LEVEL SECURITY below so that even if someone connects as the
-- owner role, the policies still apply.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_app') THEN
        CREATE ROLE postwave_app LOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users   TO postwave_app;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;

-- tenants:
--   * Mutations (INSERT/UPDATE/DELETE) MUST target the current tenant only.
--   * SELECT is permitted broadly so that the tenant-context middleware can
--     resolve a slug -> tenant id BEFORE it knows which tenant it is. Once
--     `app.tenant_id` is set, the application code stays scoped to that id
--     by convention; the row count is naturally bounded (one row per tenant
--     in this table). All sibling tables (users, audit_log, subscribers,
--     migration_jobs) carry a strict tenant_id RLS policy.
CREATE POLICY tenant_isolation_select ON tenants
    AS PERMISSIVE
    FOR SELECT
    USING (true);

CREATE POLICY tenant_isolation_insert ON tenants
    FOR INSERT
    WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_update ON tenants
    FOR UPDATE
    USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_delete ON tenants
    FOR DELETE
    USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON users
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
