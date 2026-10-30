-- 0437_accounts.sql
--
-- SUB-012 — first-class B2B Account / Company object.
--
-- Today "company" is only a recognised merge field (MergeFieldKeys,
-- import.go) auto-detected on CSV import and stashed in
-- subscribers.merge_fields jsonb. There is no first-class accounts table
-- and no canonical many-to-one link from a contact to its org, so B2B
-- metadata (industry, country, arbitrary org-level traits) is scattered
-- across merge_fields + custom_fields blobs with no schema home. This is
-- the ActiveCampaign / HubSpot "Accounts" object — an org-level record
-- that many contacts point at.
--
-- This migration creates the tenant-scoped, RLS-protected `accounts`
-- table. The 0438 companion migration adds subscribers.account_id (the
-- nullable many-to-one FK) so a contact can be linked to exactly one
-- account while the denormalised merge_fields.COMPANY pointer is left
-- intact for back-compat.
--
-- RLS GUC idiom is the repo standard:
--   NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- (a raw ::uuid cast crashes when the GUC is unset). Patterns copied from
-- subscriber_retention_policy#0426 and subscriber_computed_traits#0324.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE accounts (and
-- the 0438 column drop).

BEGIN;

CREATE TABLE IF NOT EXISTS accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Display name of the company / org. Required and non-empty.
    name        text NOT NULL CHECK (length(btrim(name)) > 0),
    -- Optional org-level traits. industry / country are promoted to
    -- first-class columns because they're the common segment/sort axes;
    -- everything else lives in the metadata jsonb blob.
    industry    text NOT NULL DEFAULT '',
    -- ISO 3166-1 alpha-2 country code, best-effort. Empty = unknown.
    country     text NOT NULL DEFAULT '',
    -- Free-form org-level traits (employee_count, plan_tier, domain, ...).
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE accounts IS
    'SUB-012 first-class B2B account/company object. Contacts link via subscribers.account_id (0438). The denormalised merge_fields.COMPANY pointer is preserved for back-compat.';

-- Listings + name search are tenant-scoped and ordered by name.
CREATE INDEX IF NOT EXISTS accounts_tenant_name_idx
    ON accounts (tenant_id, lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO postwave_app;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON accounts;
CREATE POLICY tenant_isolation ON accounts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON accounts;
CREATE POLICY tenant_visible ON accounts
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
