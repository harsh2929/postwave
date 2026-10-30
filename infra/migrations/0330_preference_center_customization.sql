-- 0330_preference_center_customization.sql
--
-- p0-privacy-portal-routes (P0, Phase 0)
--
-- The Privacy Portal frontend renders a "Preference Center Customization"
-- sub-form (apps/desktop/src/components/privacy/PreferenceCenterCustomization.tsx)
-- that lets the operator set the logo URL, primary color, footer copy
-- and "Powered by Postwave" badge for the hosted preference page
-- (`/api/public/preferences/{token}`). The frontend has been calling
-- `GET/PATCH /api/v1/privacy/portal/preference-center` since the
-- component shipped, but no backend ever existed and the route 404'd.
--
-- This migration adds the storage layer: one row per tenant, holding
-- the four customization fields. The frontend defaults
-- (defaultPreferenceCustomization() in api-client.ts) are mirrored as
-- column defaults so a tenant that's never edited their preferences
-- still gets a sensible theme.
--
-- The table is plain CREATE TABLE rather than a JSONB column on
-- tenant_public_settings because (a) the preference-center theme is
-- editable by the privacy-admin role, not the archive-admin role —
-- different RBAC surface, (b) keeping the columns typed gives us
-- server-side validation of `primary_color` (#RRGGBB) without a
-- JSONB CHECK constraint, and (c) future fields like `cta_label`,
-- `gdpr_link_url`, `dsr_link_url` can be added as plain ALTER TABLE
-- ADD COLUMN without an out-of-band JSONB migration.
--
-- RLS follows the project idiom (NULLIF on the GUC to survive an
-- unset tenant; see <local-home>/.claude/projects/-Users-
-- harshbishnoi-postwave/memory/project_rls_guc_idiom.md).

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_preference_customization (
    tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    logo_url             text NOT NULL DEFAULT '',
    primary_color        text NOT NULL DEFAULT '#5B6CFF'
                         CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
    footer_text          text NOT NULL DEFAULT 'You''re receiving this because you subscribed.',
    show_postwave_badge  boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_preference_customization IS
    'p0-privacy-portal-routes: per-tenant theme + copy overrides for the hosted preference center (apps/api/internal/preferences). One row per tenant. Empty/missing rows fall back to the package defaults in defaultPreferenceCustomization() (api-client.ts).';

CREATE TRIGGER tenant_preference_customization_set_updated_at
    BEFORE UPDATE ON tenant_preference_customization
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_preference_customization TO postwave_app;

ALTER TABLE tenant_preference_customization ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_preference_customization FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_preference_customization
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_preference_customization
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
