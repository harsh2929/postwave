-- 2042_ops_coverage_aggregates.sql
-- Fleet aggregates for four ops-console coverage surfaces that had no check at
-- all: outbound webhooks, the flow engine, authentication sessions, and
-- signup/activation growth.
--
-- WHY THESE FOUR AND NOT MORE. The console now declares 25 coverage domains and
-- renders the unwatched ones as an UNWATCHED lane rather than as silence. The
-- honest way to close a gap is a probe whose failure mode is understood; a
-- check written against a table whose semantics the author guessed at is worse
-- than the gap, because it converts an admitted unknown into a false assurance.
-- These four are backed by columns with unambiguous meaning (a delivery status
-- enum, a run status enum, session expiry/revocation, row creation time). The
-- remaining domains stay UNWATCHED on purpose until someone who knows the
-- semantics writes their probe.
--
-- SECURITY. Same boundary as 1738: postwave_ops has NO base-table access and
-- reads the fleet only through SECURITY DEFINER functions whose RETURN TYPE is
-- the boundary. Every function here returns counts and timestamps only — no
-- tenant row, no subscriber, no email address, no payload. The definer role
-- (postwave_ops_views_definer, created and attribute-asserted in 1738) gets
-- column-level SELECT on exactly the columns the bodies read.
--
-- search_path pins pg_catalog first and includes pg_temp explicitly: an omitted
-- pg_temp is searched first implicitly and lets a caller shadow an unqualified
-- type or relation inside the definer identity (the class of regression 2040
-- swept up).
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Additive functions and column grants only. Drop the five
-- functions and redeploy the previous image; the checks that call them are
-- registered in internal/ops/checks and must be reverted in lockstep.

BEGIN;

-- The definer role must already exist with the attributes 1738 asserted. If it
-- does not, this migration is being applied out of order and must not proceed:
-- silently creating a weaker role would quietly widen the boundary.
DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    SELECT * INTO definer FROM pg_roles WHERE rolname = 'postwave_ops_views_definer';
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'postwave_ops_views_definer is absent; apply 1738_ops_views_functions.sql before 2042';
    END IF;
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_ops_views_definer has unsafe role attributes; reconcile it before applying 2042';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_webhook_delivery_health', 'ops_flow_run_health',
             'ops_session_health', 'ops_growth_snapshot'
           )
    ) THEN
        RAISE EXCEPTION
            'one or more 2042 ops functions already exist out of band; remove and audit them before retrying';
    END IF;
END;
$$;

GRANT USAGE, CREATE ON SCHEMA public TO postwave_ops_views_definer;

GRANT SELECT (status, created_at, next_attempt_at, attempt_count)
    ON public.outbound_webhook_deliveries TO postwave_ops_views_definer;
GRANT SELECT (status, created_at, scheduled_at, started_at)
    ON public.flow_runs TO postwave_ops_views_definer;
GRANT SELECT (issued_at, expires_at, revoked_at, mfa_satisfied)
    ON public.auth_sessions TO postwave_ops_views_definer;
GRANT SELECT (created_at)
    ON public.subscribers TO postwave_ops_views_definer;
GRANT SELECT (created_at)
    ON public.tenants TO postwave_ops_views_definer;

-- 1. Outbound webhook delivery health.
--
-- 'exhausted' is the terminal failure state: retries are spent and the
-- customer's system is now permanently out of sync with ours, with no error
-- anywhere on our side. 'pending' past its next_attempt_at means the delivery
-- worker is not draining, which looks identical to an idle queue unless
-- something measures the age.
CREATE FUNCTION public.ops_webhook_delivery_health()
RETURNS TABLE (
    pending           bigint,
    overdue           bigint,
    exhausted_24h     bigint,
    oldest_pending_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT
        count(*) FILTER (WHERE status = 'pending')::bigint,
        count(*) FILTER (WHERE status = 'pending' AND next_attempt_at < now() - interval '5 minutes')::bigint,
        count(*) FILTER (WHERE status = 'exhausted' AND created_at > now() - interval '24 hours')::bigint,
        min(created_at) FILTER (WHERE status = 'pending')
      FROM public.outbound_webhook_deliveries;
$$;

-- 2. Flow engine health.
--
-- A queued run whose scheduled_at has long passed means the flow engine is not
-- draining. Customers experience that as a welcome series that never arrives,
-- which is indistinguishable from nobody qualifying for it.
CREATE FUNCTION public.ops_flow_run_health()
RETURNS TABLE (
    queued           bigint,
    running          bigint,
    failed_24h       bigint,
    completed_24h    bigint,
    oldest_due_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT
        count(*) FILTER (WHERE status = 'queued')::bigint,
        count(*) FILTER (WHERE status = 'running')::bigint,
        count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::bigint,
        count(*) FILTER (WHERE status = 'completed' AND created_at > now() - interval '24 hours')::bigint,
        min(scheduled_at) FILTER (WHERE status = 'queued' AND scheduled_at <= now())
      FROM public.flow_runs;
$$;

-- 3. Authentication session health.
--
-- Counts only. An expired session that was never revoked is not itself a
-- vulnerability -- expiry is enforced on read -- but a large and growing
-- population of them means the session reaper is not running, and the reaper
-- is also what removes revoked sessions after a compromise.
CREATE FUNCTION public.ops_session_health()
RETURNS TABLE (
    active            bigint,
    expired_unreaped  bigint,
    revoked_unreaped  bigint,
    oldest_expired_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT
        count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::bigint,
        count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now() - interval '7 days')::bigint,
        count(*) FILTER (WHERE revoked_at IS NOT NULL AND revoked_at <= now() - interval '7 days')::bigint,
        min(expires_at) FILTER (WHERE revoked_at IS NULL AND expires_at <= now())
      FROM public.auth_sessions;
$$;

-- 4. Growth snapshot.
--
-- Deliberately a COUNT of rows created, never their contents. A broken signup
-- or import path presents as a quiet week rather than as an error.
--
-- The 30-day window exists so the check can watch the SHAPE rather than the
-- level. A threshold on the level ("fewer than N signups is bad") is unknowable
-- before launch and would sit permanently red, get snoozed, and take the lane's
-- credibility with it. "There were signups in the last 30 days and none in the
-- last 7" needs no threshold, is falsifiable, and is correctly silent while
-- there is no traffic to measure.
CREATE FUNCTION public.ops_growth_snapshot()
RETURNS TABLE (
    subscribers_24h bigint,
    subscribers_7d  bigint,
    subscribers_30d bigint,
    tenants_24h     bigint,
    tenants_30d     bigint,
    tenants_total   bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT
        (SELECT count(*) FROM public.subscribers WHERE created_at > now() - interval '24 hours')::bigint,
        (SELECT count(*) FROM public.subscribers WHERE created_at > now() - interval '7 days')::bigint,
        (SELECT count(*) FROM public.subscribers WHERE created_at > now() - interval '30 days')::bigint,
        (SELECT count(*) FROM public.tenants     WHERE created_at > now() - interval '24 hours')::bigint,
        (SELECT count(*) FROM public.tenants     WHERE created_at > now() - interval '30 days')::bigint,
        (SELECT count(*) FROM public.tenants)::bigint;
$$;

-- Ownership is part of the boundary. CREATE FUNCTION (not OR REPLACE) above
-- rejected any pre-existing object and its potentially unsafe owner/ACL.
ALTER FUNCTION public.ops_webhook_delivery_health() OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_flow_run_health()         OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_session_health()          OWNER TO postwave_ops_views_definer;
ALTER FUNCTION public.ops_growth_snapshot()         OWNER TO postwave_ops_views_definer;

REVOKE CREATE ON SCHEMA public FROM postwave_ops_views_definer;

-- The return type is the boundary; EXECUTE is the only grant. Revoke from both
-- grantees first so the final ACL is deterministic even if role defaults change.
REVOKE ALL ON FUNCTION public.ops_webhook_delivery_health() FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_flow_run_health()         FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_session_health()          FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_growth_snapshot()         FROM PUBLIC, postwave_ops;

GRANT EXECUTE ON FUNCTION public.ops_webhook_delivery_health() TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_flow_run_health()         TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_session_health()          TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_growth_snapshot()         TO postwave_ops;

-- Fail closed if the boundary did not hold.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_webhook_delivery_health', 'ops_flow_run_health',
             'ops_session_health', 'ops_growth_snapshot'
           )
           AND (
             NOT p.prosecdef
             OR pg_get_userbyid(p.proowner) <> 'postwave_ops_views_definer'
             OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'])
           )
    ) THEN
        RAISE EXCEPTION '2042 functions must be SECURITY DEFINER, owned by the definer role, with a pinned search_path';
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
           AND c.relname IN (
             'outbound_webhook_deliveries', 'flow_runs', 'auth_sessions',
             'subscribers', 'tenants'
           )
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND has_column_privilege('postwave_ops', c.oid, a.attnum,
                                    'SELECT,INSERT,UPDATE,REFERENCES')
    ) THEN
        RAISE EXCEPTION 'postwave_ops must not have direct base-table access';
    END IF;
END;
$$;

COMMIT;
