-- 1764_subscriber_contact_performance_indexes.sql
--
-- Subscriber Detail's 90-day Contact Performance report reads two write-hot
-- ledgers by exact tenant + CITEXT subscriber identity + trailing timestamp:
--
--   campaign_recipients: successful sends (status='sent', sent_at >= $since)
--   conversions:         monetary revenue (amount_cents IS NOT NULL,
--                        occurred_at >= $since)
--
-- The pre-1764 indexes are tenant-only/time-only or campaign-first. At a large
-- tenant they force a broad 90-day or tenant scan every time one subscriber
-- detail panel opens. These partial indexes mirror the production predicates
-- and column expressions exactly. INCLUDE makes the revenue aggregation
-- index-only once visibility-map coverage permits it.
--
-- Preflight:
--   * verify campaign_recipients.subscriber_email and
--     conversions.subscriber_email are CITEXT (migration 0068 / 0049);
--   * verify no valid, same-named index with a different definition exists;
--     the migration runner removes only an interrupted invalid concurrent
--     shell and attests the completed definition fingerprint;
--   * allow enough temporary disk for concurrent builds on both live ledgers.
--
-- The two CREATE INDEX CONCURRENTLY statements intentionally precede the
-- transactional function/privilege phase. PostgreSQL forbids concurrent index
-- builds inside a transaction, and both tables accept live writes.
--
-- rollback-strategy: no-op - both indexes are additive and safe to retain when application code rolls back.
-- rollback-details: If storage pressure requires removal after rollback, run DROP INDEX CONCURRENTLY IF EXISTS campaign_recipients_contact_performance_sent_idx; then DROP INDEX CONCURRENTLY IF EXISTS conversions_contact_performance_revenue_idx; the previous application remains correct but resumes broad scans.

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_recipients_contact_performance_sent_idx
    ON campaign_recipients (tenant_id, subscriber_email, sent_at DESC)
    WHERE status = 'sent' AND sent_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_contact_performance_revenue_idx
    ON conversions (tenant_id, subscriber_email, occurred_at DESC)
    INCLUDE (amount_cents, currency)
    WHERE subscriber_email IS NOT NULL AND amount_cents IS NOT NULL;

-- campaign_recipients has an app.outbox_worker GUC policy in addition to its
-- tenant policy. Under FORCE RLS PostgreSQL must treat that OR boundary as a
-- security barrier, so CITEXT equality cannot be pushed into the otherwise
-- correct contact index for postwave_app. Do not weaken RLS or expose whole
-- recipient rows. This scalar-only definer validates the authenticated tenant
-- and canonical address before using the index behind RLS.
BEGIN;

DO $migration$
DECLARE
    definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_subscriber_metrics_definer'
    ) THEN
        CREATE ROLE postwave_subscriber_metrics_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO definer
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_subscriber_metrics_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_subscriber_metrics_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_subscriber_metrics_definer must have no memberships';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_subscriber_metrics_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION
            'postwave_subscriber_metrics_definer unexpectedly has CREATE on public';
    END IF;
    IF pg_catalog.to_regprocedure(
        'public.subscriber_contact_sent_count(uuid,text,timestamp with time zone)'
    ) IS NOT NULL THEN
        RAISE EXCEPTION
            'subscriber_contact_sent_count(uuid,text,timestamptz) exists out of band';
    END IF;
END;
$migration$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_subscriber_metrics_definer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
    FROM postwave_subscriber_metrics_definer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
    FROM postwave_subscriber_metrics_definer;
REVOKE ALL PRIVILEGES ON SCHEMA public
    FROM postwave_subscriber_metrics_definer;

GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_subscriber_metrics_definer;
GRANT SELECT (tenant_id, subscriber_email, status, sent_at)
    ON public.campaign_recipients
    TO postwave_subscriber_metrics_definer;

CREATE FUNCTION public.subscriber_contact_sent_count(
    p_tenant_id uuid,
    p_subscriber_email text,
    p_since timestamp with time zone
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    authenticated_tenant text := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    );
    local_part text;
    domain_part text;
    domain_label text;
    result_count bigint;
BEGIN
    -- Fail before touching the ledger. app.outbox_worker is deliberately not
    -- an authority for this request-scoped metric.
    IF p_tenant_id IS NULL OR authenticated_tenant IS NULL OR
       authenticated_tenant <> p_tenant_id::text THEN
        RAISE EXCEPTION 'authenticated tenant does not match requested tenant'
            USING ERRCODE = '42501';
    END IF;

    -- Mirror the subscriber identity contract: one lowercase ASCII dot-atom
    -- mailbox, SMTP envelope bounds, and a DNS-shaped multi-label domain.
    IF p_subscriber_email IS NULL OR
       pg_catalog.octet_length(p_subscriber_email) < 3 OR
       pg_catalog.octet_length(p_subscriber_email) > 254 OR
       p_subscriber_email <> pg_catalog.btrim(p_subscriber_email) OR
       p_subscriber_email <> pg_catalog.lower(p_subscriber_email) OR
       pg_catalog.length(p_subscriber_email) -
           pg_catalog.length(pg_catalog.replace(p_subscriber_email, '@', '')) <> 1 THEN
        RAISE EXCEPTION 'subscriber email must be canonical'
            USING ERRCODE = '22023';
    END IF;

    local_part := pg_catalog.split_part(p_subscriber_email, '@', 1);
    domain_part := pg_catalog.split_part(p_subscriber_email, '@', 2);
    IF pg_catalog.octet_length(local_part) < 1 OR
       pg_catalog.octet_length(local_part) > 64 OR
       local_part LIKE '.%' OR local_part LIKE '%.' OR
       pg_catalog.strpos(local_part, '..') > 0 OR
       local_part !~ $local_re$^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$$local_re$ OR
       pg_catalog.strpos(domain_part, '.') = 0 THEN
        RAISE EXCEPTION 'subscriber email must be canonical'
            USING ERRCODE = '22023';
    END IF;

    FOREACH domain_label IN ARRAY pg_catalog.string_to_array(domain_part, '.')
    LOOP
        IF pg_catalog.octet_length(domain_label) < 1 OR
           pg_catalog.octet_length(domain_label) > 63 OR
           domain_label !~ $domain_re$^[a-z0-9]([a-z0-9-]*[a-z0-9])?$$domain_re$ THEN
            RAISE EXCEPTION 'subscriber email must be canonical'
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    IF p_since IS NULL OR
       p_since < pg_catalog.statement_timestamp() - INTERVAL '366 days' OR
       p_since > pg_catalog.statement_timestamp() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'since must be within the bounded trailing window'
            USING ERRCODE = '22023';
    END IF;

    SELECT pg_catalog.count(*)::bigint
      INTO result_count
      FROM public.campaign_recipients AS recipient
     WHERE recipient.tenant_id = p_tenant_id
       AND recipient.subscriber_email = p_subscriber_email::public.citext
       AND recipient.status = 'sent'
       AND recipient.sent_at >= p_since;

    RETURN GREATEST(result_count, 0::bigint);
END;
$function$;

ALTER FUNCTION public.subscriber_contact_sent_count(
    uuid, text, timestamp with time zone
) OWNER TO postwave_subscriber_metrics_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_subscriber_metrics_definer;
REVOKE ALL ON FUNCTION public.subscriber_contact_sent_count(
    uuid, text, timestamp with time zone
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_contact_sent_count(
    uuid, text, timestamp with time zone
) TO postwave_app;

COMMENT ON FUNCTION public.subscriber_contact_sent_count(
    uuid, text, timestamp with time zone
) IS
    'Returns one bounded tenant-authenticated successful-send count; exposes no campaign-recipient row or identity field.';

DO $postcheck$
DECLARE
    definer_oid oid := (
        SELECT oid FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_subscriber_metrics_definer'
    );
    app_oid oid := (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postwave_app'
    );
    function_oid oid := pg_catalog.to_regprocedure(
        'public.subscriber_contact_sent_count(uuid,text,timestamp with time zone)'
    );
BEGIN
    IF function_oid IS NULL THEN
        RAISE EXCEPTION 'subscriber contact sent-count function is missing';
    END IF;
    IF NOT pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'tenant_id', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'subscriber_email', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'status', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'sent_at', 'SELECT'
    ) THEN
        RAISE EXCEPTION 'subscriber metrics definer lacks required columns';
    END IF;
    IF pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'id', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'campaign_id', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'error', 'SELECT'
    ) OR pg_catalog.has_table_privilege(
        'postwave_subscriber_metrics_definer', 'public.campaign_recipients',
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_table_privilege(
        'postwave_subscriber_metrics_definer', 'public.subscribers', 'SELECT'
    ) OR pg_catalog.has_table_privilege(
        'postwave_subscriber_metrics_definer', 'public.conversions', 'SELECT'
    ) THEN
        RAISE EXCEPTION
            'subscriber metrics definer has unrelated identity, table, or write privilege';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_subscriber_metrics_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION
            'subscriber metrics definer retained schema CREATE';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM information_schema.column_privileges AS privilege
         WHERE privilege.grantee = 'postwave_subscriber_metrics_definer'
           AND privilege.table_schema = 'public'
           AND (
               privilege.table_name <> 'campaign_recipients' OR
               privilege.column_name NOT IN (
                   'tenant_id', 'subscriber_email', 'status', 'sent_at'
               ) OR
               privilege.privilege_type <> 'SELECT'
           )
    ) THEN
        RAISE EXCEPTION
            'subscriber metrics definer retained an unrelated column grant';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = proc.pronamespace
          JOIN pg_catalog.pg_language AS language
            ON language.oid = proc.prolang
         WHERE proc.oid = function_oid
           AND (
               namespace.nspname <> 'public' OR
               proc.proowner <> definer_oid OR
               NOT proc.prosecdef OR
               proc.provolatile <> 's' OR
               proc.prokind <> 'f' OR
               proc.prorettype <> 'pg_catalog.int8'::pg_catalog.regtype OR
               language.lanname <> 'plpgsql' OR
               proc.proconfig IS DISTINCT FROM
                   ARRAY['search_path=pg_catalog']::text[]
           )
    ) THEN
        RAISE EXCEPTION 'subscriber contact function metadata is unsafe';
    END IF;
    IF NOT pg_catalog.has_function_privilege(
        'postwave_app', function_oid, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        0::oid, function_oid, 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'subscriber contact function ACL is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                  proc.proacl,
                  pg_catalog.acldefault('f', proc.proowner)
              )
          ) AS acl
         WHERE proc.oid = function_oid
           AND acl.privilege_type = 'EXECUTE'
           AND acl.grantee NOT IN (definer_oid, app_oid)
    ) THEN
        RAISE EXCEPTION 'unexpected subscriber contact function grantee';
    END IF;
END;
$postcheck$;

COMMIT;
