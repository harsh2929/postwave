-- 1738_ops_views_functions.sql
-- Cross-tenant read functions for the ops-console "views" package.
--
-- The ops pool connects as postwave_ops, which (by deliberate design, see
-- 1700_ops_console.sql) has NO SELECT on any base table: it reads the fleet
-- ONLY through SECURITY DEFINER functions whose return type is the security
-- boundary — "aggregates, not rows, enforced by GRANT". The v1 views package
-- shipped direct base-table SELECTs (tenants, campaign_recipients, billing_state,
-- outbox_events, subscriber_events, tenant_usage_snapshots); those are permission
-- denied under postwave_ops and only appeared to work against a dev superuser.
--
-- This migration moves each view read behind a SECURITY DEFINER function that
-- returns exactly the columns the console renders — tenant metadata (id, slug,
-- name, tier, plan/dunning state) and aggregate counts/rates. None returns a
-- subscriber row, an email address, or a message body: the return type cannot
-- leak one no matter what the body does. postwave_ops gets EXECUTE only.
--
-- rollback-strategy: no-op - additive functions and grants; drop them and
-- redeploy the previous image. The views package must be reverted in lockstep
-- (it calls these functions instead of the base tables).

BEGIN;

-- Own the definer functions with a purpose-built, non-login role instead of
-- the migration superuser. BYPASSRLS is required for intentional fleet-wide
-- aggregates; its base-table access is restricted to the exact columns used
-- below, and NOINHERIT prevents privilege expansion through memberships.
DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_ops_views_definer') THEN
        CREATE ROLE postwave_ops_views_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO definer FROM pg_roles WHERE rolname = 'postwave_ops_views_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_ops_views_definer has unsafe role attributes; reconcile it before applying 1738';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_auth_members
         WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_ops_views_definer')
            OR roleid = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_ops_views_definer')
    ) THEN
        RAISE EXCEPTION
            'postwave_ops_views_definer has role memberships; revoke them before applying 1738';
    END IF;
    IF has_schema_privilege('postwave_ops', 'public', 'CREATE') OR
       has_schema_privilege('postwave_ops_views_definer', 'public', 'CREATE') THEN
        RAISE EXCEPTION
            'ops roles must not have CREATE on schema public before SECURITY DEFINER functions are installed';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_tenant_directory', 'ops_send_queue_depth',
             'ops_send_dead_letters', 'ops_deliverability_by_tenant',
             'ops_billing_by_tenant'
           )
    ) THEN
        RAISE EXCEPTION
            'one or more 1738 ops functions already exist out of band; remove and audit them before retrying';
    END IF;
END;
$$;

-- Remove any direct relation grants if the role was pre-provisioned. The
-- function bodies below are static and need only the explicitly granted
-- columns. CREATE is granted on public only for the ownership hand-off later
-- in this transaction, then revoked and asserted absent before commit.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_ops_views_definer;
GRANT USAGE, CREATE ON SCHEMA public TO postwave_ops_views_definer;

GRANT SELECT (id, slug, name, tier, metadata, created_at)
    ON public.tenants TO postwave_ops_views_definer;
GRANT SELECT (tenant_id, current_period_end, dunning)
    ON public.billing_state TO postwave_ops_views_definer;
GRANT SELECT (tenant_id, status, sent_at)
    ON public.campaign_recipients TO postwave_ops_views_definer;
GRANT SELECT (tenant_id, kind, failed_at)
    ON public.outbox_events TO postwave_ops_views_definer;
GRANT SELECT (tenant_id, event_type, at)
    ON public.subscriber_events TO postwave_ops_views_definer;
GRANT SELECT (tenant_id, month_start, monthly_sends)
    ON public.tenant_usage_snapshots TO postwave_ops_views_definer;

-- 1. Tenant directory. sending_paused is a JSONB path on tenants.metadata (the
-- kill switch is not a table); dunning/current_period_end come from billing_state.
-- p_search is the already-escaped prefix (the caller escapes % and _); the
-- ESCAPE clause keeps a literal search literal.
CREATE FUNCTION public.ops_tenant_directory(p_search text, p_limit int)
RETURNS TABLE (
    tenant_id          text,
    slug               text,
    name               text,
    tier               text,
    current_period_end timestamptz,
    dunning            boolean,
    sending_paused     boolean,
    created_at         timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;
    IF p_search IS NULL OR octet_length(p_search) > 128 THEN
        RAISE EXCEPTION 'p_search must be non-null and at most 128 bytes'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT t.id::text, t.slug, t.name, t.tier,
           bs.current_period_end,
           COALESCE(bs.dunning, false),
           COALESCE(
             t.metadata #>> '{sending,email_paused}',
             t.metadata ->> 'email_sending_paused',
             'false'
           ) IN ('true', 't', '1', 'yes', 'on'),
           t.created_at
      FROM public.tenants AS t
      LEFT JOIN public.billing_state AS bs ON bs.tenant_id = t.id
     WHERE (p_search = ''
            OR t.name ILIKE p_search || '%' ESCAPE E'\\'
            OR t.slug ILIKE p_search || '%' ESCAPE E'\\')
     ORDER BY t.created_at DESC
     LIMIT p_limit;
END;
$$;

-- 2. Send-queue depth: pending/failed campaign_recipients per tenant.
CREATE FUNCTION public.ops_send_queue_depth(p_limit int)
RETURNS TABLE (
    tenant_id text,
    slug      text,
    name      text,
    pending   bigint,
    failed    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT cr.tenant_id::text, t.slug, t.name,
           COUNT(*) FILTER (WHERE cr.status = 'pending')::bigint,
           COUNT(*) FILTER (WHERE cr.status = 'failed')::bigint
      FROM public.campaign_recipients AS cr
      JOIN public.tenants AS t ON t.id = cr.tenant_id
     WHERE cr.status IN ('pending','failed')
     GROUP BY cr.tenant_id, t.slug, t.name
    HAVING COUNT(*) FILTER (WHERE cr.status IN ('pending','failed')) > 0
     ORDER BY COUNT(*) FILTER (WHERE cr.status = 'pending') DESC,
              COUNT(*) FILTER (WHERE cr.status = 'failed')  DESC
     LIMIT p_limit;
END;
$$;

-- 3. Outbox dead-letters: failed_at-set events grouped by (tenant, kind).
CREATE FUNCTION public.ops_send_dead_letters(p_limit int)
RETURNS TABLE (
    tenant_id     text,
    slug          text,
    kind          text,
    dead_count    bigint,
    oldest_dead_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT oe.tenant_id::text, t.slug, oe.kind,
           COUNT(*)::bigint,
           MIN(oe.failed_at)
      FROM public.outbox_events AS oe
      JOIN public.tenants AS t ON t.id = oe.tenant_id
     WHERE oe.failed_at IS NOT NULL
     GROUP BY oe.tenant_id, t.slug, oe.kind
     ORDER BY MIN(oe.failed_at) ASC
     LIMIT p_limit;
END;
$$;

-- 4. Deliverability: 7-day sent/complained/bounced/unsubscribed per tenant.
-- Denominator is campaign_recipients.sent_at (the real send ledger); the event
-- counts come from subscriber_events. Rates are computed by the caller.
CREATE FUNCTION public.ops_deliverability_by_tenant(p_limit int)
RETURNS TABLE (
    tenant_id     text,
    slug          text,
    name          text,
    sent_7d       bigint,
    complained_7d bigint,
    bounced_7d    bigint,
    unsub_7d      bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH sent AS (
      SELECT cr.tenant_id, COUNT(*)::bigint AS sent_7d
        FROM public.campaign_recipients AS cr
       WHERE cr.status = 'sent' AND cr.sent_at > now() - INTERVAL '7 days'
       GROUP BY cr.tenant_id
    ),
    ev AS (
      SELECT se.tenant_id,
             COUNT(*) FILTER (WHERE se.event_type = 'complained')::bigint   AS complained_7d,
             COUNT(*) FILTER (WHERE se.event_type = 'bounced')::bigint       AS bounced_7d,
             COUNT(*) FILTER (WHERE se.event_type = 'unsubscribed')::bigint  AS unsub_7d
        FROM public.subscriber_events AS se
       WHERE se.at > now() - INTERVAL '7 days'
         AND se.event_type IN ('complained','bounced','unsubscribed')
       GROUP BY se.tenant_id
    )
    SELECT t.id::text, t.slug, t.name,
           COALESCE(sent.sent_7d, 0),
           COALESCE(ev.complained_7d, 0),
           COALESCE(ev.bounced_7d, 0),
           COALESCE(ev.unsub_7d, 0)
      FROM public.tenants AS t
      LEFT JOIN sent ON sent.tenant_id = t.id
      LEFT JOIN ev   ON ev.tenant_id = t.id
     WHERE COALESCE(sent.sent_7d,0) > 0
        OR COALESCE(ev.complained_7d,0) > 0
        OR COALESCE(ev.bounced_7d,0) > 0
     ORDER BY (CASE WHEN COALESCE(sent.sent_7d,0) > 0
                    THEN COALESCE(ev.complained_7d,0)::float8 / sent.sent_7d
                    ELSE 0 END) DESC
     LIMIT p_limit;
END;
$$;

-- 5. Billing: per-tenant dunning + current-month send usage. Cap is derived by
-- the caller from tier (studio/sending/pro).
CREATE FUNCTION public.ops_billing_by_tenant(p_limit int)
RETURNS TABLE (
    tenant_id    text,
    slug         text,
    name         text,
    tier         text,
    dunning      boolean,
    monthly_used bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT t.id::text, t.slug, t.name, t.tier,
           COALESCE(bs.dunning, false),
           COALESCE(us.monthly_sends, 0)::bigint
      FROM public.tenants AS t
      LEFT JOIN public.billing_state AS bs ON bs.tenant_id = t.id
      LEFT JOIN public.tenant_usage_snapshots AS us
             ON us.tenant_id = t.id
            AND us.month_start = date_trunc('month', now())::date
     ORDER BY COALESCE(bs.dunning, false) DESC,
              COALESCE(us.monthly_sends, 0) DESC
     LIMIT p_limit;
END;
$$;

-- Ownership is part of the boundary. CREATE FUNCTION (not OR REPLACE) above
-- rejected any pre-existing object and its potentially unsafe owner/ACL. The
-- dedicated owner needed CREATE on public only for this ownership hand-off.
ALTER FUNCTION public.ops_tenant_directory(text, int)
    OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_send_queue_depth(int)
    OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_send_dead_letters(int)
    OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_deliverability_by_tenant(int)
    OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_billing_by_tenant(int)
    OWNER TO postwave_ops_views_definer;

REVOKE CREATE ON SCHEMA public FROM postwave_ops_views_definer;

-- The return type is the boundary; EXECUTE is the only grant. Revoke from both
-- grantees first so the final ACL is deterministic even if role defaults change.
REVOKE ALL ON FUNCTION public.ops_tenant_directory(text, int)
    FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_send_queue_depth(int)
    FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_send_dead_letters(int)
    FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_deliverability_by_tenant(int)
    FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_billing_by_tenant(int)
    FROM PUBLIC, postwave_ops;

GRANT EXECUTE ON FUNCTION public.ops_tenant_directory(text, int)
    TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_send_queue_depth(int)
    TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_send_dead_letters(int)
    TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_deliverability_by_tenant(int)
    TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_billing_by_tenant(int)
    TO postwave_ops;

-- Fail closed if ownership, ACLs, signatures, role isolation, or relation
-- privileges differ from the reviewed boundary. This turns environmental drift
-- into a failed migration rather than a silently over-privileged deployment.
DO $$
DECLARE
    definer_oid oid;
    ops_oid oid;
    definer pg_roles%ROWTYPE;
BEGIN
    SELECT * INTO definer
      FROM pg_roles
     WHERE rolname = 'postwave_ops_views_definer';
    definer_oid := definer.oid;
    SELECT oid INTO ops_oid FROM pg_roles WHERE rolname = 'postwave_ops';

    IF definer_oid IS NULL OR ops_oid IS NULL THEN
        RAISE EXCEPTION 'required ops roles are missing';
    END IF;
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_ops_views_definer role attributes drifted during 1738';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_auth_members
         WHERE member = definer_oid OR roleid = definer_oid
    ) THEN
        RAISE EXCEPTION 'postwave_ops_views_definer must have no role memberships or members';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_default_acl AS d
          CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
         WHERE acl.grantee = definer_oid
    ) THEN
        RAISE EXCEPTION 'default privileges must not expand postwave_ops_views_definer access';
    END IF;
    IF NOT has_schema_privilege('postwave_ops_views_definer', 'public', 'USAGE') OR
       has_schema_privilege('postwave_ops_views_definer', 'public', 'CREATE') OR
       has_schema_privilege('postwave_ops', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'ops schema privileges are outside the reviewed boundary';
    END IF;

    IF to_regprocedure('public.ops_tenant_directory(text,integer)') IS NULL OR
       to_regprocedure('public.ops_send_queue_depth(integer)') IS NULL OR
       to_regprocedure('public.ops_send_dead_letters(integer)') IS NULL OR
       to_regprocedure('public.ops_deliverability_by_tenant(integer)') IS NULL OR
       to_regprocedure('public.ops_billing_by_tenant(integer)') IS NULL THEN
        RAISE EXCEPTION 'one or more reviewed 1738 function signatures are missing';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_tenant_directory', 'ops_send_queue_depth',
             'ops_send_dead_letters', 'ops_deliverability_by_tenant',
             'ops_billing_by_tenant'
           )
    ) <> 5 THEN
        RAISE EXCEPTION 'unexpected overload exists for a reviewed 1738 function name';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          JOIN pg_language AS l ON l.oid = p.prolang
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_tenant_directory', 'ops_send_queue_depth',
             'ops_send_dead_letters', 'ops_deliverability_by_tenant',
             'ops_billing_by_tenant'
           )
           AND (
             p.proowner <> definer_oid OR
             NOT p.prosecdef OR
             p.provolatile <> 's' OR
             p.prokind <> 'f' OR
             l.lanname <> 'plpgsql' OR
             p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
           )
    ) THEN
        RAISE EXCEPTION '1738 function owner or SECURITY DEFINER metadata is unsafe';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_tenant_directory', 'ops_send_queue_depth',
             'ops_send_dead_letters', 'ops_deliverability_by_tenant',
             'ops_billing_by_tenant'
           )
           AND (
             acl.privilege_type <> 'EXECUTE' OR
             acl.grantee NOT IN (definer_oid, ops_oid) OR
             (acl.grantee = ops_oid AND acl.is_grantable)
           )
    ) THEN
        RAISE EXCEPTION '1738 function ACL contains an unexpected grantee or privilege';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_tenant_directory', 'ops_send_queue_depth',
             'ops_send_dead_letters', 'ops_deliverability_by_tenant',
             'ops_billing_by_tenant'
           )
           AND acl.grantee = ops_oid
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable
    ) <> 5 OR (
        SELECT count(*)
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_tenant_directory', 'ops_send_queue_depth',
             'ops_send_dead_letters', 'ops_deliverability_by_tenant',
             'ops_billing_by_tenant'
           )
           AND acl.grantee = definer_oid
           AND acl.privilege_type = 'EXECUTE'
    ) <> 5 THEN
        RAISE EXCEPTION '1738 functions do not have the exact owner/ops EXECUTE ACL';
    END IF;

    IF EXISTS (
        WITH expected(table_name, column_name) AS (
            VALUES
              ('tenants', 'id'), ('tenants', 'slug'), ('tenants', 'name'),
              ('tenants', 'tier'), ('tenants', 'metadata'), ('tenants', 'created_at'),
              ('billing_state', 'tenant_id'), ('billing_state', 'current_period_end'),
              ('billing_state', 'dunning'),
              ('campaign_recipients', 'tenant_id'), ('campaign_recipients', 'status'),
              ('campaign_recipients', 'sent_at'),
              ('outbox_events', 'tenant_id'), ('outbox_events', 'kind'),
              ('outbox_events', 'failed_at'),
              ('subscriber_events', 'tenant_id'), ('subscriber_events', 'event_type'),
              ('subscriber_events', 'at'),
              ('tenant_usage_snapshots', 'tenant_id'),
              ('tenant_usage_snapshots', 'month_start'),
              ('tenant_usage_snapshots', 'monthly_sends')
        )
        SELECT 1
          FROM expected AS e
         WHERE NOT has_column_privilege(
           'postwave_ops_views_definer',
           format('public.%I', e.table_name),
           e.column_name,
           'SELECT'
         )
    ) THEN
        RAISE EXCEPTION 'postwave_ops_views_definer lacks a required column grant';
    END IF;
    IF EXISTS (
        WITH expected(table_name, column_name) AS (
            VALUES
              ('tenants', 'id'), ('tenants', 'slug'), ('tenants', 'name'),
              ('tenants', 'tier'), ('tenants', 'metadata'), ('tenants', 'created_at'),
              ('billing_state', 'tenant_id'), ('billing_state', 'current_period_end'),
              ('billing_state', 'dunning'),
              ('campaign_recipients', 'tenant_id'), ('campaign_recipients', 'status'),
              ('campaign_recipients', 'sent_at'),
              ('outbox_events', 'tenant_id'), ('outbox_events', 'kind'),
              ('outbox_events', 'failed_at'),
              ('subscriber_events', 'tenant_id'), ('subscriber_events', 'event_type'),
              ('subscriber_events', 'at'),
              ('tenant_usage_snapshots', 'tenant_id'),
              ('tenant_usage_snapshots', 'month_start'),
              ('tenant_usage_snapshots', 'monthly_sends')
        )
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
          JOIN pg_attribute AS a ON a.attrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND has_column_privilege(
             'postwave_ops_views_definer', c.oid, a.attnum, 'SELECT'
           )
           AND NOT EXISTS (
             SELECT 1
               FROM expected AS e
              WHERE e.table_name = c.relname
                AND e.column_name = a.attname
           )
    ) OR EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege(
             'postwave_ops_views_definer', c.oid,
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
    ) THEN
        RAISE EXCEPTION 'postwave_ops_views_definer has an unexpected relation privilege';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN (
             'tenants', 'billing_state', 'campaign_recipients',
             'outbox_events', 'subscriber_events', 'tenant_usage_snapshots'
           )
           AND has_table_privilege(
             'postwave_ops', c.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
    ) OR EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
          JOIN pg_attribute AS a ON a.attrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relname IN (
             'tenants', 'billing_state', 'campaign_recipients',
             'outbox_events', 'subscriber_events', 'tenant_usage_snapshots'
           )
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND has_column_privilege(
             'postwave_ops', c.oid, a.attnum,
             'SELECT,INSERT,UPDATE,REFERENCES'
           )
    ) THEN
        RAISE EXCEPTION 'postwave_ops must not have direct base-table access';
    END IF;
END;
$$;

COMMIT;
