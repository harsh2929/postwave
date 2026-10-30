-- 2043_ops_send_pipeline_health.sql
-- The send pipeline aggregate.
--
-- WHY THIS EXISTS SEPARATELY FROM ops_send_queue_depth. That function (1738)
-- answers "which tenants have a backlog", which is a directory question. It
-- carries no AGE, and depth without age cannot distinguish a queue that is
-- draining from one that has stopped: a healthy sender with ten thousand
-- pending recipients and a dead one with ten thousand pending recipients look
-- identical.
--
-- The signal that matters is claimed-and-never-finished. A recipient in
-- 'sending' whose claimed_at is old means the sender process died between
-- claiming the row and recording the outcome. Those recipients are in limbo:
-- not sent, not failed, not retried. The send-guard-stuck-recovery worker is
-- supposed to reclaim them, so a persistently old claim means the RECOVERY has
-- failed too, which is why the red threshold is generous rather than tight.
--
-- SECURITY. Same boundary as 1738 and 2042: postwave_ops has no base-table
-- access and the return type is the boundary — counts and one timestamp, never
-- a recipient, an address, or a campaign.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: One additive function and one column grant. Drop the
-- function and redeploy the previous image; the sending.pipeline-stalled check
-- in internal/ops/checks must be reverted in lockstep.

BEGIN;

DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    SELECT * INTO definer FROM pg_roles WHERE rolname = 'postwave_ops_views_definer';
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'postwave_ops_views_definer is absent; apply 1738_ops_views_functions.sql before 2043';
    END IF;
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_ops_views_definer has unsafe role attributes; reconcile it before applying 2043';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'ops_send_pipeline_health'
    ) THEN
        RAISE EXCEPTION
            'ops_send_pipeline_health already exists out of band; remove and audit it before retrying';
    END IF;
END;
$$;

GRANT USAGE, CREATE ON SCHEMA public TO postwave_ops_views_definer;

-- 1738 already granted (tenant_id, status, sent_at). claimed_at is the column
-- that turns depth into age, and it is the only addition.
GRANT SELECT (claimed_at) ON public.campaign_recipients TO postwave_ops_views_definer;

CREATE FUNCTION public.ops_send_pipeline_health()
RETURNS TABLE (
    pending           bigint,
    sending           bigint,
    failed            bigint,
    oldest_claimed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT
        count(*) FILTER (WHERE status = 'pending')::bigint,
        count(*) FILTER (WHERE status = 'sending')::bigint,
        count(*) FILTER (WHERE status = 'failed')::bigint,
        min(claimed_at) FILTER (WHERE status = 'sending')
      FROM public.campaign_recipients;
$$;

ALTER FUNCTION public.ops_send_pipeline_health() OWNER TO postwave_ops_views_definer;

REVOKE CREATE ON SCHEMA public FROM postwave_ops_views_definer;

REVOKE ALL ON FUNCTION public.ops_send_pipeline_health() FROM PUBLIC, postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_send_pipeline_health() TO postwave_ops;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'ops_send_pipeline_health'
           AND (
             NOT p.prosecdef
             OR pg_get_userbyid(p.proowner) <> 'postwave_ops_views_definer'
             OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'])
           )
    ) THEN
        RAISE EXCEPTION 'ops_send_pipeline_health must be SECURITY DEFINER, owned by the definer role, with a pinned search_path';
    END IF;

    IF has_schema_privilege('postwave_ops_views_definer', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'the definer role must not retain CREATE on schema public';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
          JOIN pg_attribute AS a ON a.attrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relname = 'campaign_recipients'
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND has_column_privilege('postwave_ops', c.oid, a.attnum,
                                    'SELECT,INSERT,UPDATE,REFERENCES')
    ) THEN
        RAISE EXCEPTION 'postwave_ops must not have direct access to campaign_recipients';
    END IF;
END;
$$;

COMMIT;
