-- 0463_tenant_identifier_transforms.sql
--
-- SUB-018 — Identifier normalization transforms at ingest (per-tenant config).
--
-- Email lowercasing is already unconditional in the subscriber ingest path
-- (handlers.go:normalizeEmail). What's missing is a tenant-configurable set of
-- *optional* identifier transforms that operators can opt into:
--
--   * email_normalize_dots  — strip dots from the email local-part
--                             (Gmail-style: "j.o.h.n@gmail.com" -> "john@gmail.com").
--   * email_normalize_plus  — drop the "+tag" sub-address from the local-part
--                             ("john+promo@gmail.com" -> "john@gmail.com").
--   * phone_e164_format     — coerce phone identifiers to E.164
--                             ("(415) 555-2671" + default region US -> "+14155552671").
--   * phone_default_region  — ISO 3166-1 alpha-2 region used to interpret a
--                             phone number that lacks an explicit country code.
--
-- Defaults are all OFF / conservative so a tenant that never touches this
-- surface sees byte-identical ingest behaviour (lowercase only). The values
-- live in a dedicated tenant-scoped settings table holding at most one row per
-- tenant; when the row is absent, the normalizer uses its built-in defaults
-- (every transform disabled).
--
-- Tenant-scoped table -> tenant_id uuid + RLS, with the GUC read via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset GUC does
-- not crash the policy. Shape copied from 0450_tenant_custom_field_settings.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_identifier_transforms (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Email local-part transforms. Both default false (off) so existing
    -- tenants keep the lowercase-only behaviour they have today.
    email_normalize_dots boolean     NOT NULL DEFAULT false,
    email_normalize_plus boolean     NOT NULL DEFAULT false,
    -- Phone E.164 coercion. Off by default; phone_default_region is the ISO
    -- 3166-1 alpha-2 region used to interpret national-format numbers.
    phone_e164_format    boolean     NOT NULL DEFAULT false,
    phone_default_region text        NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_identifier_transforms_region_chk
        CHECK (phone_default_region = '' OR phone_default_region ~ '^[A-Z]{2}$')
);

-- At most one settings row per tenant. Drives the upsert used by the admin
-- PATCH endpoint (ON CONFLICT (tenant_id) DO UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_identifier_transforms_tenant_idx
    ON tenant_identifier_transforms (tenant_id);

CREATE TRIGGER tenant_identifier_transforms_set_updated_at
    BEFORE UPDATE ON tenant_identifier_transforms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_identifier_transforms TO postwave_app;

ALTER TABLE tenant_identifier_transforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_identifier_transforms FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_identifier_transforms
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
