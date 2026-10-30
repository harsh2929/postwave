-- The scoring scheduler historically queried subscribers and
-- subscriber_events under app.outbox_worker. The effective RLS policies do not
-- expose either table to that scope, so the real postwave_app role discovered
-- zero tenants and automatic scoring never ran.
--
-- Do not solve this by adding a cross-tenant row policy to a general runtime
-- role: RLS controls rows, not columns, and that would let the scope read every
-- subscriber PII column. Instead expose one bounded SECURITY DEFINER function
-- whose return type is only tenant UUIDs. Its purpose-built NOLOGIN/BYPASSRLS
-- owner has SELECT on exactly four aggregate/discovery columns and no write or
-- subscriber-identity privilege.
-- rollback-strategy: expand-contract - the previous release ignores the new
-- function; retain it during application rollback.

BEGIN;

-- Remove the policy names used by an unreleased development prototype. They
-- must never become the production boundary because either one exposes whole
-- rows rather than only candidate tenant IDs.
DROP POLICY IF EXISTS subscribers_scoring_worker_select ON public.subscribers;
DROP POLICY IF EXISTS subscriber_events_scoring_worker_select ON public.subscriber_events;

DO $$
DECLARE
    definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_scoring_discovery_definer'
    ) THEN
        CREATE ROLE postwave_scoring_discovery_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO definer
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_scoring_discovery_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_scoring_discovery_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_scoring_discovery_definer must have no memberships';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_scoring_discovery_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION
            'postwave_scoring_discovery_definer unexpectedly has CREATE on public';
    END IF;
    IF pg_catalog.to_regprocedure(
        'public.scoring_discovery_tenants(integer)'
    ) IS NOT NULL THEN
        RAISE EXCEPTION
            'scoring_discovery_tenants(integer) exists out of band';
    END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_scoring_discovery_definer;
GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_scoring_discovery_definer;
GRANT SELECT (tenant_id, engagement_score)
    ON public.subscribers TO postwave_scoring_discovery_definer;
GRANT SELECT (tenant_id, at)
    ON public.subscriber_events TO postwave_scoring_discovery_definer;

CREATE FUNCTION public.scoring_discovery_tenants(p_window_days integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 3650 THEN
        RAISE EXCEPTION 'p_window_days must be between 1 and 3650'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT candidate.tenant_id
      FROM (
            SELECT events.tenant_id
              FROM public.subscriber_events AS events
             WHERE events.at > pg_catalog.now()
                   - (p_window_days * INTERVAL '1 day')
             GROUP BY events.tenant_id
            UNION
            SELECT subscribers.tenant_id
              FROM public.subscribers AS subscribers
             WHERE subscribers.engagement_score <> 0
             GROUP BY subscribers.tenant_id
      ) AS candidate;
END;
$$;

ALTER FUNCTION public.scoring_discovery_tenants(integer)
    OWNER TO postwave_scoring_discovery_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_scoring_discovery_definer;
REVOKE ALL ON FUNCTION public.scoring_discovery_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scoring_discovery_tenants(integer)
    TO postwave_app;

COMMENT ON FUNCTION public.scoring_discovery_tenants(integer) IS
    'Returns only tenant IDs needing score recomputation; the definer can read tenant_id/at/engagement_score but no subscriber identity or write column.';

DO $$
DECLARE
    definer_oid oid := (
        SELECT oid FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_scoring_discovery_definer'
    );
    app_oid oid := (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postwave_app'
    );
BEGIN
    IF NOT pg_catalog.has_column_privilege(
        'postwave_scoring_discovery_definer', 'public.subscribers',
        'engagement_score', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_scoring_discovery_definer', 'public.subscriber_events',
        'at', 'SELECT'
    ) THEN
        RAISE EXCEPTION 'scoring definer lacks required discovery columns';
    END IF;
    IF pg_catalog.has_column_privilege(
        'postwave_scoring_discovery_definer', 'public.subscribers',
        'email', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_scoring_discovery_definer', 'public.subscriber_events',
        'subscriber_email', 'SELECT'
    ) OR pg_catalog.has_table_privilege(
        'postwave_scoring_discovery_definer', 'public.subscribers',
        'INSERT,UPDATE,DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_scoring_discovery_definer', 'public.subscriber_events',
        'INSERT,UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'scoring definer has subscriber identity or write privilege';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = proc.pronamespace
          JOIN pg_catalog.pg_language AS language
            ON language.oid = proc.prolang
         WHERE namespace.nspname = 'public'
           AND proc.proname = 'scoring_discovery_tenants'
           AND (
               proc.proowner <> definer_oid OR
               NOT proc.prosecdef OR
               proc.provolatile <> 's' OR
               proc.prokind <> 'f' OR
               language.lanname <> 'plpgsql' OR
               proc.proconfig IS DISTINCT FROM
                   ARRAY['search_path=pg_catalog']::text[]
           )
    ) THEN
        RAISE EXCEPTION 'scoring discovery function metadata is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = proc.pronamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                  proc.proacl,
                  pg_catalog.acldefault('f', proc.proowner)
              )
          ) AS acl
         WHERE namespace.nspname = 'public'
           AND proc.proname = 'scoring_discovery_tenants'
           AND acl.privilege_type = 'EXECUTE'
           AND acl.grantee NOT IN (definer_oid, app_oid)
    ) THEN
        RAISE EXCEPTION 'unexpected scoring discovery function grantee';
    END IF;
END;
$$;

COMMIT;
