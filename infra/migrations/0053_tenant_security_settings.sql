-- 0053_tenant_security_settings.sql
--
-- Tenant-level security policy surface. Postwave delegates auth to an
-- upstream IdP (Google / Okta / Microsoft / SAML), so we don't store
-- TOTP secrets here. What we DO store is the tenant's chosen security
-- posture so the dashboard can advertise it and ops can enforce it
-- (e.g. block API keys whose creator's IdP session lacks the MFA
-- claim when require_2fa_for_admins = true).
--
-- This is a 1:1 row per tenant. Inserted lazily by the settings
-- handler the first time a tenant opens /app/settings/audit (or any
-- of the security UIs).

BEGIN;

CREATE TABLE tenant_security_settings (
    tenant_id               uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    require_2fa_for_admins  boolean NOT NULL DEFAULT false,
    require_2fa_for_all     boolean NOT NULL DEFAULT false,
    -- Free-text identifier for the upstream IdP the tenant uses.
    -- e.g. "google", "okta", "microsoft", "saml-custom". Populated
    -- by ops when a tenant onboards with SSO; null = email/password.
    sso_provider            text,
    sso_metadata_url        text,
    -- Session lifetime override; null = use platform default (24h).
    session_max_minutes     int,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    updated_by              uuid REFERENCES users(id) ON DELETE SET NULL
);

GRANT SELECT, INSERT, UPDATE ON tenant_security_settings TO postwave_app;

ALTER TABLE tenant_security_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_security_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_security_settings
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
