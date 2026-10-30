-- 1955_offer_public_resolution_hardening.sql
--
-- Fail-closed offer action URLs and a least-privilege public tenant resolver.
-- Public offer HTTP requests have no tenant session, but the application role
-- must not receive a general cross-tenant table bypass merely to resolve an
-- unguessable offer UUID. A dedicated NOLOGIN/NOBYPASSRLS function owner gets
-- exactly id+tenant_id SELECT and one explicit SELECT-only policy.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the resolver until every API binary has reverted to
-- a tenant-bound offer URL. URL and composite-FK constraints may remain.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Existing unsafe rows must be repaired deliberately rather than becoming
-- executable public links after this migration.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.offers
         WHERE (action_url <> '' AND NOT (
                    action_url = btrim(action_url)
                AND action_url ~ '^https://[^/@?#[:space:]]+(:[0-9]{1,5})?([/?][^#[:cntrl:][:space:]]*)?$'
              ))
            OR (terms_url <> '' AND NOT (
                    terms_url = btrim(terms_url)
                AND terms_url ~ '^https://[^/@?#[:space:]]+(:[0-9]{1,5})?([/?][^#[:cntrl:][:space:]]*)?$'
              ))
    ) THEN
        RAISE EXCEPTION 'offers contain unsafe public URLs; repair them before migration 1955';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.offers AS o
          JOIN public.campaigns AS c ON c.id = o.campaign_id
         WHERE o.campaign_id IS NOT NULL AND c.tenant_id <> o.tenant_id
    ) THEN
        RAISE EXCEPTION 'offers contain cross-tenant campaign references';
    END IF;
END;
$$;

ALTER TABLE public.offers
    ADD CONSTRAINT offers_action_url_https_check CHECK (
        action_url = '' OR (
            action_url = btrim(action_url)
            AND action_url ~ '^https://[^/@?#[:space:]]+(:[0-9]{1,5})?([/?][^#[:cntrl:][:space:]]*)?$'
        )
    ),
    ADD CONSTRAINT offers_terms_url_https_check CHECK (
        terms_url = '' OR (
            terms_url = btrim(terms_url)
            AND terms_url ~ '^https://[^/@?#[:space:]]+(:[0-9]{1,5})?([/?][^#[:cntrl:][:space:]]*)?$'
        )
    ),
    ADD CONSTRAINT offers_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.offers
    DROP CONSTRAINT offers_campaign_id_fkey,
    ADD CONSTRAINT offers_campaign_tenant_fkey
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES public.campaigns (tenant_id, id)
        ON DELETE SET NULL (campaign_id);

ALTER TABLE public.offers FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
    resolver pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'postwave_offer_resolver'
    ) THEN
        CREATE ROLE postwave_offer_resolver
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;
    SELECT * INTO resolver FROM pg_roles WHERE rolname = 'postwave_offer_resolver';
    IF resolver.rolcanlogin OR resolver.rolsuper OR resolver.rolcreatedb OR
       resolver.rolcreaterole OR resolver.rolinherit OR resolver.rolreplication OR
       resolver.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_offer_resolver has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_auth_members
         WHERE member = resolver.oid OR roleid = resolver.oid
    ) THEN
        RAISE EXCEPTION 'postwave_offer_resolver must have no memberships or members';
    END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON public.offers FROM postwave_offer_resolver;
GRANT SELECT (id, tenant_id) ON public.offers TO postwave_offer_resolver;

DROP POLICY IF EXISTS offers_public_resolver_select ON public.offers;
CREATE POLICY offers_public_resolver_select ON public.offers
    FOR SELECT TO postwave_offer_resolver
    USING (true);

GRANT USAGE, CREATE ON SCHEMA public TO postwave_offer_resolver;

CREATE OR REPLACE FUNCTION public.resolve_public_offer_tenant(p_offer_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
    SELECT o.tenant_id
      FROM public.offers AS o
     WHERE o.id = p_offer_id
$function$;

ALTER FUNCTION public.resolve_public_offer_tenant(uuid)
    OWNER TO postwave_offer_resolver;
REVOKE ALL ON FUNCTION public.resolve_public_offer_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_public_offer_tenant(uuid) FROM postwave_offer_resolver;
GRANT EXECUTE ON FUNCTION public.resolve_public_offer_tenant(uuid) TO postwave_app;

REVOKE CREATE ON SCHEMA public FROM postwave_offer_resolver;

DO $$
BEGIN
    IF has_schema_privilege('postwave_offer_resolver', 'public', 'CREATE') OR
       has_table_privilege('postwave_offer_resolver', 'public.offers', 'INSERT') OR
       has_table_privilege('postwave_offer_resolver', 'public.offers', 'UPDATE') OR
       has_table_privilege('postwave_offer_resolver', 'public.offers', 'DELETE') OR
       NOT has_column_privilege('postwave_offer_resolver', 'public.offers', 'id', 'SELECT') OR
       NOT has_column_privilege('postwave_offer_resolver', 'public.offers', 'tenant_id', 'SELECT') OR
       has_function_privilege('public', 'public.resolve_public_offer_tenant(uuid)', 'EXECUTE') OR
       NOT has_function_privilege('postwave_app', 'public.resolve_public_offer_tenant(uuid)', 'EXECUTE')
    THEN
        RAISE EXCEPTION 'offer resolver privilege self-audit failed';
    END IF;
END;
$$;

COMMIT;
