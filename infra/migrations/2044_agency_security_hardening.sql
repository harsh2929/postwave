-- 2044_agency_security_hardening.sql
--
-- Contain the legacy agency cross-tenant surface. Parent-scoped application
-- transactions previously acquired general SELECT authority over every child
-- tenants row and, through app.agency_aggregator, every child event row. Those
-- policies applied to every query in the transaction, not only agency handlers.
-- This migration removes both ambient grants and retains one fixed, bounded,
-- tenant-bound roster projection. Billing mutation and invoice preview remain
-- release-held in the API until payer authority and a rated ledger exist.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: restoring ambient parent/event policies would reopen
-- cross-tenant reads. Roll forward with a reviewed projection if needed.

BEGIN;

-- No caller-set custom GUC is an authorization credential. No HTTP path needs
-- cross-tenant subscriber_events access after invoice preview containment.
DROP POLICY IF EXISTS subscriber_events_agency_aggregator ON public.subscriber_events;
DROP POLICY IF EXISTS subscriber_events_agency_parent_select ON public.subscriber_events;
-- 0339 renamed the pre-partition table after 0155 had installed its policy,
-- so that policy travelled onto the attached legacy partition. Direct reads
-- of a partition apply the partition's own RLS and grants; leaving this copy
-- installed would preserve the same caller-GUC bypass for historical rows.
DROP POLICY IF EXISTS subscriber_events_agency_aggregator ON public.subscriber_events_legacy;
DROP POLICY IF EXISTS subscriber_events_agency_parent_select ON public.subscriber_events_legacy;

-- A parent tenant no longer receives general-purpose SELECT authority over a
-- child's tenants row. The fixed function below is the only parent projection.
DROP POLICY IF EXISTS tenant_agency_children_select ON public.tenants;

-- The legacy owner-context view was globally enumerable by postwave_app and is
-- unused by runtime source. Dropping it is safer than preserving a second API.
DROP VIEW IF EXISTS public.agency_child_usage_v;

-- No billing-history parent consumer exists. Limit the app role to history of
-- the currently bound tenant instead of granting former/current parents an
-- ambient join-based policy.
DROP POLICY IF EXISTS tenant_visible ON public.tenant_billing_mode_history;
DROP POLICY IF EXISTS tenant_billing_history_self ON public.tenant_billing_mode_history;
CREATE POLICY tenant_billing_history_self
    ON public.tenant_billing_mode_history
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- A parent-billed tenant without a live parent has no accountable payer. NOT
-- VALID preserves migration of legacy drift while rejecting new violations.
ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_parent_billing_requires_parent
    CHECK (billing_mode <> 'parent' OR parent_tenant_id IS NOT NULL)
    NOT VALID;

-- Branding gets a dedicated timestamp and monotonic validator because
-- tenants.updated_at changes for unrelated workspace settings. Existing rows
-- are initialized to this migration transaction's timestamp; future branding
-- writers must advance both dedicated fields in the same statement.
ALTER TABLE public.tenants
    ADD COLUMN agency_branding_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN agency_branding_revision bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT tenants_agency_branding_revision_nonnegative
        CHECK (agency_branding_revision >= 0);

-- Enabled custom domains are reserved routing identities even though public
-- custom-domain resolution is not shipped. Never let two tenants reserve the
-- same case-folded identity.
DROP INDEX IF EXISTS public.idx_tenants_whitelabel_domain;
CREATE UNIQUE INDEX idx_tenants_whitelabel_domain
    ON public.tenants (lower(whitelabel_custom_domain))
    WHERE whitelabel_custom_domain IS NOT NULL
      AND whitelabel_enabled = true;

-- Match the roster function's seek predicate and deterministic order so each
-- bounded page remains indexable as an agency grows.
CREATE INDEX idx_tenants_agency_roster_page
    ON public.tenants (parent_tenant_id, created_at, id)
    WHERE parent_tenant_id IS NOT NULL;

-- Purpose-built BYPASSRLS owner for one exact roster projection. BYPASSRLS is
-- explicit because tenants uses FORCE RLS; column grants and the function's
-- fixed return type are the boundary. The role cannot login, inherit, create
-- objects after installation, or hold memberships.
DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer'
    ) THEN
        CREATE ROLE postwave_agency_roster_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO definer
      FROM pg_roles
     WHERE rolname = 'postwave_agency_roster_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_agency_roster_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_agency_roster_definer must not have role memberships';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'agency_list_children'
    ) THEN
        RAISE EXCEPTION
            'agency_list_children already exists out of band; remove and audit it before retrying';
    END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON public.tenants FROM postwave_agency_roster_definer;
GRANT USAGE, CREATE ON SCHEMA public TO postwave_agency_roster_definer;
GRANT SELECT (
    id, slug, name, tier, parent_tenant_id, is_agency_account, billing_mode,
    reseller_markup_bps, whitelabel_enabled, created_at, updated_at
) ON public.tenants TO postwave_agency_roster_definer;

CREATE FUNCTION public.agency_list_children(
    p_parent_id uuid,
    p_after_created_at timestamptz,
    p_after_id uuid,
    p_limit integer
)
RETURNS TABLE (
    child_id text,
    slug text,
    name text,
    tier text,
    parent_tenant_id text,
    billing_mode text,
    reseller_markup_bps integer,
    whitelabel_enabled boolean,
    created_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- Naming pg_temp explicitly, last, prevents PostgreSQL's implicit-first temp
-- lookup from resolving a caller-created relation or type in definer context.
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
DECLARE
    bound_tenant text;
BEGIN
    IF p_parent_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 201 THEN
        RAISE EXCEPTION 'invalid agency roster parameters' USING ERRCODE = '22023';
    END IF;
    IF (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
        RAISE EXCEPTION 'agency roster cursor must be complete' USING ERRCODE = '22023';
    END IF;

    bound_tenant := NULLIF(current_setting('app.tenant_id', true), '');
    IF bound_tenant IS NULL OR bound_tenant <> p_parent_id::text THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM public.tenants AS parent
         WHERE parent.id = p_parent_id
           AND parent.is_agency_account = true
    ) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT child.id::text,
           child.slug,
           child.name,
           child.tier,
           child.parent_tenant_id::text,
           child.billing_mode,
           child.reseller_markup_bps,
           child.whitelabel_enabled,
           child.created_at,
           child.updated_at
      FROM public.tenants AS child
     WHERE child.parent_tenant_id = p_parent_id
       AND (
           p_after_created_at IS NULL OR
           (child.created_at, child.id) > (p_after_created_at, p_after_id)
       )
     ORDER BY child.created_at, child.id
     LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.agency_list_children(uuid, timestamptz, uuid, integer)
    OWNER TO postwave_agency_roster_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_agency_roster_definer;
REVOKE ALL ON FUNCTION public.agency_list_children(uuid, timestamptz, uuid, integer)
    FROM PUBLIC, postwave_app;
GRANT EXECUTE ON FUNCTION public.agency_list_children(uuid, timestamptz, uuid, integer)
    TO postwave_app;

COMMENT ON FUNCTION public.agency_list_children(uuid, timestamptz, uuid, integer)
IS 'Fixed tenant-bound agency child roster projection; bounded to 201 rows and ordered by created_at,id.';

-- Fail closed if ownership, function hardening, or ambient policy removal did
-- not produce the intended boundary.
DO $$
DECLARE
    granted_columns text[];
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_policies
         WHERE schemaname = 'public'
           AND policyname IN (
               'subscriber_events_agency_aggregator',
               'subscriber_events_agency_parent_select',
               'tenant_agency_children_select'
           )
    ) THEN
        RAISE EXCEPTION 'ambient agency RLS policies remain installed';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'agency_list_children'
           AND p.oid = 'public.agency_list_children(uuid,timestamptz,uuid,integer)'::regprocedure
           AND p.prosecdef
           AND p.provolatile = 's'
           AND pg_get_userbyid(p.proowner) = 'postwave_agency_roster_definer'
           AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
           AND COALESCE(p.proconfig @> ARRAY['row_security=off'], false)
    ) THEN
        RAISE EXCEPTION 'agency_list_children definer boundary is malformed';
    END IF;
    IF has_schema_privilege('postwave_agency_roster_definer', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'agency roster definer must not retain schema CREATE';
    END IF;
    IF NOT has_schema_privilege('postwave_agency_roster_definer', 'public', 'USAGE') THEN
        RAISE EXCEPTION 'agency roster definer requires only public schema USAGE';
    END IF;
    IF has_function_privilege(
        'public',
        'public.agency_list_children(uuid,timestamptz,uuid,integer)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'postwave_app',
        'public.agency_list_children(uuid,timestamptz,uuid,integer)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'agency_list_children execute ACL is malformed';
    END IF;

    SELECT array_agg(a.attname::text ORDER BY a.attname)
      INTO granted_columns
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_attribute AS a ON a.attrelid = c.oid
     CROSS JOIN LATERAL aclexplode(
           COALESCE(a.attacl, acldefault('c', c.relowner))
     ) AS acl
      JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE n.nspname = 'public'
       AND c.relname = 'tenants'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND grantee.rolname = 'postwave_agency_roster_definer'
       AND acl.privilege_type = 'SELECT'
       AND NOT acl.is_grantable;
    IF granted_columns IS DISTINCT FROM ARRAY[
        'billing_mode', 'created_at', 'id', 'is_agency_account', 'name',
        'parent_tenant_id', 'reseller_markup_bps', 'slug', 'tier',
        'updated_at', 'whitelabel_enabled'
    ]::text[] THEN
        RAISE EXCEPTION
            'agency roster definer tenant column grants are malformed: %',
            granted_columns;
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
          JOIN pg_attribute AS a ON a.attrelid = c.oid
         CROSS JOIN LATERAL aclexplode(
               COALESCE(a.attacl, acldefault('c', c.relowner))
         ) AS acl
          JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
         WHERE n.nspname = 'public'
           AND grantee.rolname = 'postwave_agency_roster_definer'
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND (c.relname <> 'tenants' OR acl.privilege_type <> 'SELECT' OR acl.is_grantable)
    ) THEN
        RAISE EXCEPTION 'agency roster definer has unexpected column privileges';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege(
               'postwave_agency_roster_definer', c.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
    ) THEN
        RAISE EXCEPTION 'agency roster definer has unexpected table-level privileges';
    END IF;
    IF EXISTS (
        WITH sequences AS MATERIALIZED (
            SELECT c.oid
              FROM pg_class AS c
              JOIN pg_namespace AS n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'S'
        )
        SELECT 1
          FROM sequences
         WHERE has_sequence_privilege(
             'postwave_agency_roster_definer', oid, 'USAGE,SELECT,UPDATE'
         )
    ) THEN
        RAISE EXCEPTION 'agency roster definer has unexpected sequence privileges';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_class
         WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer')
    ) OR EXISTS (
        SELECT 1
          FROM pg_type
         WHERE typowner = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer')
    ) OR EXISTS (
        SELECT 1
          FROM pg_namespace
         WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer')
    ) OR EXISTS (
        SELECT 1
          FROM pg_proc
         WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_agency_roster_definer')
           AND oid <> 'public.agency_list_children(uuid,timestamptz,uuid,integer)'::regprocedure
    ) THEN
        RAISE EXCEPTION 'agency roster definer owns an unexpected database object';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.tenants'::regclass
           AND conname = 'tenants_agency_branding_revision_nonnegative'
           AND convalidated
    ) THEN
        RAISE EXCEPTION 'agency branding revision constraint is not valid';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_index
         WHERE indexrelid = 'public.idx_tenants_agency_roster_page'::regclass
           AND indisvalid
           AND indisready
           AND indkey::text = (
               SELECT string_agg(attnum::text, ' ' ORDER BY position)
                 FROM unnest(ARRAY[
                     (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.tenants'::regclass AND attname = 'parent_tenant_id'),
                     (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.tenants'::regclass AND attname = 'created_at'),
                     (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.tenants'::regclass AND attname = 'id')
                 ]) WITH ORDINALITY AS wanted(attnum, position)
           )
    ) THEN
        RAISE EXCEPTION 'agency roster paging index is malformed';
    END IF;
END;
$$;

COMMIT;
