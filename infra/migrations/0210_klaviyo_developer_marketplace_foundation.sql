-- 0210_klaviyo_developer_marketplace_foundation.sql
--
-- Klaviyo parity slice KLV-13: developer apps, OAuth distribution,
-- app marketplace listings, app-scoped webhooks, partner profiles, and
-- test-account ledgers.

BEGIN;

CREATE TABLE developer_apps (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             text NOT NULL,
    slug             citext NOT NULL,
    app_type         text NOT NULL DEFAULT 'private'
                     CHECK (app_type IN ('private','public','native','catalog_only')),
    distribution     text NOT NULL DEFAULT 'private'
                     CHECK (distribution IN ('private','marketplace','partner_catalog')),
    status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','submitted','in_review','approved','active','suspended','rejected','archived')),
    owner_email      citext,
    support_email    citext,
    homepage_url     text NOT NULL DEFAULT '',
    privacy_url      text NOT NULL DEFAULT '',
    terms_url        text NOT NULL DEFAULT '',
    description      text NOT NULL DEFAULT '',
    scopes           text[] NOT NULL DEFAULT '{}'::text[],
    redirect_uris    text[] NOT NULL DEFAULT '{}'::text[],
    api_revisions    text[] NOT NULL DEFAULT ARRAY['2026-05-29'],
    webhook_topics   text[] NOT NULL DEFAULT '{}'::text[],
    test_mode        boolean NOT NULL DEFAULT false,
    metadata         jsonb NOT NULL DEFAULT '{}',
    review_notes     text NOT NULL DEFAULT '',
    submitted_at     timestamptz,
    approved_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX developer_apps_tenant_status_idx
    ON developer_apps (tenant_id, status, updated_at DESC);
CREATE INDEX developer_apps_public_idx
    ON developer_apps (distribution, status, updated_at DESC)
    WHERE distribution IN ('marketplace','partner_catalog')
      AND status IN ('approved','active');

CREATE TRIGGER developer_apps_set_updated_at
    BEFORE UPDATE ON developer_apps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON developer_apps TO postwave_app;

ALTER TABLE developer_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_public_developer_apps ON developer_apps
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            distribution IN ('marketplace','partner_catalog')
            AND status IN ('approved','active')
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible_developer_apps ON developer_apps
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            distribution IN ('marketplace','partner_catalog')
            AND status IN ('approved','active')
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE oauth_clients (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    app_id              uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    client_id           text NOT NULL UNIQUE,
    client_secret_hash  text NOT NULL,
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','rotated','revoked')),
    redirect_uris       text[] NOT NULL DEFAULT '{}'::text[],
    scopes              text[] NOT NULL DEFAULT '{}'::text[],
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz
);

CREATE INDEX oauth_clients_tenant_app_idx
    ON oauth_clients (tenant_id, app_id, created_at DESC);

CREATE TRIGGER oauth_clients_set_updated_at
    BEFORE UPDATE ON oauth_clients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_clients TO postwave_app;

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_clients
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON oauth_clients
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE app_installations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    app_id          uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    installed_by    text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT 'installed'
                    CHECK (status IN ('installed','suspended','revoked')),
    granted_scopes  text[] NOT NULL DEFAULT '{}'::text[],
    config          jsonb NOT NULL DEFAULT '{}',
    installed_at    timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    UNIQUE (tenant_id, app_id)
);

CREATE INDEX app_installations_tenant_status_idx
    ON app_installations (tenant_id, status, updated_at DESC);

CREATE TRIGGER app_installations_set_updated_at
    BEFORE UPDATE ON app_installations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON app_installations TO postwave_app;

ALTER TABLE app_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_installations
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON app_installations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE app_listings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    app_id              uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    slug                citext NOT NULL UNIQUE,
    name                text NOT NULL,
    category            text NOT NULL DEFAULT 'marketing',
    summary             text NOT NULL DEFAULT '',
    docs_url            text NOT NULL DEFAULT '',
    support_url         text NOT NULL DEFAULT '',
    icon_url            text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','published','unlisted','archived')),
    review_state        text NOT NULL DEFAULT 'draft'
                        CHECK (review_state IN ('draft','submitted','approved','rejected')),
    partner_level       text NOT NULL DEFAULT ''
                        CHECK (partner_level IN ('','registered','certified','premier','elite')),
    tags                text[] NOT NULL DEFAULT '{}'::text[],
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, app_id)
);

CREATE INDEX app_listings_category_idx
    ON app_listings (category, status, review_state, updated_at DESC);

CREATE TRIGGER app_listings_set_updated_at
    BEFORE UPDATE ON app_listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON app_listings TO postwave_app;

ALTER TABLE app_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_listings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_public_app_listings ON app_listings
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (status = 'published' AND review_state = 'approved')
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible_app_listings ON app_listings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (status = 'published' AND review_state = 'approved')
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE app_webhook_subscriptions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    app_id              uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    installation_id     uuid REFERENCES app_installations(id) ON DELETE CASCADE,
    endpoint_url        text NOT NULL,
    topics              text[] NOT NULL DEFAULT '{}'::text[],
    signing_secret_ref  text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','revoked')),
    failure_count       integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    last_delivery_at    timestamptz,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_webhook_subscriptions_tenant_app_idx
    ON app_webhook_subscriptions (tenant_id, app_id, status, updated_at DESC);

CREATE TRIGGER app_webhook_subscriptions_set_updated_at
    BEFORE UPDATE ON app_webhook_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON app_webhook_subscriptions TO postwave_app;

ALTER TABLE app_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_webhook_subscriptions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON app_webhook_subscriptions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE partner_program_profiles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    organization_name   text NOT NULL,
    profile_type        text NOT NULL DEFAULT 'technology'
                        CHECK (profile_type IN ('technology','agency','consultant','affiliate')),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','certified','suspended','archived')),
    certification_level text NOT NULL DEFAULT 'registered'
                        CHECK (certification_level IN ('registered','certified','premier','elite')),
    regions             text[] NOT NULL DEFAULT '{}'::text[],
    verticals           text[] NOT NULL DEFAULT '{}'::text[],
    services            text[] NOT NULL DEFAULT '{}'::text[],
    listing_url         text NOT NULL DEFAULT '',
    contact_email       citext,
    metadata            jsonb NOT NULL DEFAULT '{}',
    review_notes        text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id)
);

CREATE INDEX partner_program_profiles_public_idx
    ON partner_program_profiles (profile_type, certification_level, updated_at DESC)
    WHERE status = 'certified';

CREATE TRIGGER partner_program_profiles_set_updated_at
    BEFORE UPDATE ON partner_program_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON partner_program_profiles TO postwave_app;

ALTER TABLE partner_program_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_program_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_certified_partner_profiles ON partner_program_profiles
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR status = 'certified'
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible_partner_profiles ON partner_program_profiles
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR status = 'certified'
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE developer_test_accounts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    app_id            uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
    name              text NOT NULL,
    status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','expired','revoked')),
    sandbox_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
    seeded_resources  jsonb NOT NULL DEFAULT '{}',
    expires_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX developer_test_accounts_tenant_app_idx
    ON developer_test_accounts (tenant_id, app_id, status, created_at DESC);

CREATE TRIGGER developer_test_accounts_set_updated_at
    BEFORE UPDATE ON developer_test_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON developer_test_accounts TO postwave_app;

ALTER TABLE developer_test_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_test_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON developer_test_accounts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON developer_test_accounts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE developer_app_audit_logs (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    app_id      uuid REFERENCES developer_apps(id) ON DELETE SET NULL,
    actor       text NOT NULL DEFAULT '',
    action      text NOT NULL,
    metadata    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX developer_app_audit_logs_tenant_recent_idx
    ON developer_app_audit_logs (tenant_id, created_at DESC);
CREATE INDEX developer_app_audit_logs_app_idx
    ON developer_app_audit_logs (tenant_id, app_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON developer_app_audit_logs TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE developer_app_audit_logs_id_seq TO postwave_app;

ALTER TABLE developer_app_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_app_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON developer_app_audit_logs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON developer_app_audit_logs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
