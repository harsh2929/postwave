-- 1781_form_variants_rls_semantics.sql
--
-- Migration 0289 combined a tenant-only RESTRICTIVE policy with separate
-- public PERMISSIVE policies. PostgreSQL ANDs every applicable RESTRICTIVE
-- policy on top of the OR of PERMISSIVE policies, so that arrangement denied
-- both intended paths:
--   * authenticated CRUD had no matching PERMISSIVE policy; and
--   * public render/counter operations failed the tenant-only guard.
--
-- Keep one restrictive defence-in-depth scope guard, but make its two valid
-- identities explicit: an authenticated tenant transaction OR the exact
-- public (tenant_id, form_id) pair resolved by the application. Separate
-- permissive policies then grant only the operations each identity needs.
-- Ownership EXISTS checks are intentional: form_variants.form_id is not a
-- tenant-composite foreign key, so tenant_id alone must not let tenant A attach
-- a variant to tenant B's form.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Keep the corrected least-privilege policies during application rollback. Restoring the 0289 policy combination would disable authenticated variant administration and public selection/counters.

BEGIN;

-- -------------------------------------------------------------------------
-- Variant definitions: tenant CRUD; exact published-form public read.
-- -------------------------------------------------------------------------

DROP POLICY IF EXISTS form_variants_tenant_isolation ON form_variants;
DROP POLICY IF EXISTS form_variants_public_read ON form_variants;
DROP POLICY IF EXISTS form_variants_scope_guard ON form_variants;
DROP POLICY IF EXISTS form_variants_tenant_access ON form_variants;
DROP POLICY IF EXISTS form_variants_public_select ON form_variants;

CREATE POLICY form_variants_scope_guard ON form_variants
    AS RESTRICTIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
            AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
            AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        )
    );

CREATE POLICY form_variants_tenant_access ON form_variants
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variants.form_id
               AND f.tenant_id = form_variants.tenant_id
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variants.form_id
               AND f.tenant_id = form_variants.tenant_id
        )
    );

-- All variants for the exact public form remain visible to the application
-- role. The picker itself filters to exploring/promoted rows; retaining paused
-- rows here lets a delayed submission increment the variant it was rendered
-- with after an intervening promotion paused that arm.
CREATE POLICY form_variants_public_select ON form_variants
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variants.form_id
               AND f.tenant_id = form_variants.tenant_id
               AND f.status = 'published'
        )
    );

-- -------------------------------------------------------------------------
-- Counters: tenant CRUD; exact published-form public upsert support.
--
-- PostgreSQL UPDATE/ON CONFLICT evaluates SELECT visibility in addition to
-- UPDATE policy predicates. The exact-form SELECT policy is therefore needed
-- for an atomic counter upsert; it does not broaden the bound form scope.
-- -------------------------------------------------------------------------

DROP POLICY IF EXISTS form_variant_impressions_tenant_isolation ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_public_writer ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_public_updater ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_scope_guard ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_tenant_access ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_public_select ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_public_insert ON form_variant_impressions;
DROP POLICY IF EXISTS form_variant_impressions_public_update ON form_variant_impressions;

CREATE POLICY form_variant_impressions_scope_guard ON form_variant_impressions
    AS RESTRICTIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
            AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
            AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        )
    );

CREATE POLICY form_variant_impressions_tenant_access ON form_variant_impressions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variant_impressions.form_id
               AND f.tenant_id = form_variant_impressions.tenant_id
        )
        AND EXISTS (
            SELECT 1
              FROM form_variants AS v
             WHERE v.id = form_variant_impressions.variant_id
               AND v.form_id = form_variant_impressions.form_id
               AND v.tenant_id = form_variant_impressions.tenant_id
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variant_impressions.form_id
               AND f.tenant_id = form_variant_impressions.tenant_id
        )
        AND EXISTS (
            SELECT 1
              FROM form_variants AS v
             WHERE v.id = form_variant_impressions.variant_id
               AND v.form_id = form_variant_impressions.form_id
               AND v.tenant_id = form_variant_impressions.tenant_id
        )
    );

CREATE POLICY form_variant_impressions_public_select ON form_variant_impressions
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variant_impressions.form_id
               AND f.tenant_id = form_variant_impressions.tenant_id
               AND f.status = 'published'
        )
        AND EXISTS (
            SELECT 1
              FROM form_variants AS v
             WHERE v.id = form_variant_impressions.variant_id
               AND v.form_id = form_variant_impressions.form_id
               AND v.tenant_id = form_variant_impressions.tenant_id
        )
    );

CREATE POLICY form_variant_impressions_public_insert ON form_variant_impressions
    AS PERMISSIVE FOR INSERT
    TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variant_impressions.form_id
               AND f.tenant_id = form_variant_impressions.tenant_id
               AND f.status = 'published'
        )
        AND EXISTS (
            SELECT 1
              FROM form_variants AS v
             WHERE v.id = form_variant_impressions.variant_id
               AND v.form_id = form_variant_impressions.form_id
               AND v.tenant_id = form_variant_impressions.tenant_id
        )
    );

CREATE POLICY form_variant_impressions_public_update ON form_variant_impressions
    AS PERMISSIVE FOR UPDATE
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variant_impressions.form_id
               AND f.tenant_id = form_variant_impressions.tenant_id
               AND f.status = 'published'
        )
        AND EXISTS (
            SELECT 1
              FROM form_variants AS v
             WHERE v.id = form_variant_impressions.variant_id
               AND v.form_id = form_variant_impressions.form_id
               AND v.tenant_id = form_variant_impressions.tenant_id
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms AS f
             WHERE f.id = form_variant_impressions.form_id
               AND f.tenant_id = form_variant_impressions.tenant_id
               AND f.status = 'published'
        )
        AND EXISTS (
            SELECT 1
              FROM form_variants AS v
             WHERE v.id = form_variant_impressions.variant_id
               AND v.form_id = form_variant_impressions.form_id
               AND v.tenant_id = form_variant_impressions.tenant_id
        )
    );

COMMIT;
