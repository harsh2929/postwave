-- 0147_tenant_feature_flags.sql
--
-- Per-tenant feature toggles.
--
-- A small key/value table the application uses to roll new
-- functionality out gradually without redeploys. Three patterns
-- the design supports:
--
--   1. tenant-local override   tenant_id IS NOT NULL → value wins
--   2. platform default        tenant_id IS NULL → applies to all
--   3. variant assignment      value is free-form text, not just bool
--
-- Resolution rule:
--   lookup(tenant, flag) → most-specific (tenant override) ?? default ?? null
--
-- Surfaces:
--
--   GET  /api/v1/feature-flags                    list visible (default+tenant)
--   POST /api/v1/feature-flags                    upsert tenant override
--                                                 body: {key, value}
--   DELETE /api/v1/feature-flags/{key}            clear tenant override
--   GET  /api/v1/feature-flags/{key}              resolved value

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_feature_flags (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid,                           -- NULL = platform default
    flag_key   text NOT NULL,
    value      text NOT NULL,                  -- 'true' | 'false' | 'variant_a' | …
    note       text,                           -- operator memo
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One platform default per key; one tenant override per (tenant, key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_feature_flags_default
    ON tenant_feature_flags (flag_key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_feature_flags_override
    ON tenant_feature_flags (tenant_id, flag_key) WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_feature_flags TO postwave_app;

ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;

-- Read: every tenant sees the platform defaults + their own overrides.
-- Write: tenants can only mutate their own rows; platform defaults are
-- managed via direct SQL (operator console).
CREATE POLICY tenant_visible ON tenant_feature_flags AS PERMISSIVE FOR SELECT TO postwave_app
    USING (tenant_id IS NULL
           OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY tenant_write ON tenant_feature_flags AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
