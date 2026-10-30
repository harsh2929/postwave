-- 1957_campaign_assurance_slo_health.sql
--
-- One content-free fleet aggregate for Campaign Assurance SLO telemetry and
-- the compiled ops-board check. postwave_ops retains no base-table SELECT;
-- the existing isolated, NOLOGIN/NOBYPASSRLS Campaign Assurance ops definer
-- owns this fixed-return-type function and is admitted by the reviewed RLS
-- policies installed in migration 1938.
--
-- No tenant, campaign, run, mailbox, recipient, content, MIME, extraction,
-- model output, prompt, provider payload, error message, or free-form metadata
-- can cross this boundary.
--
-- rollback-strategy: no-op. Revert the binary consumers before removing the
-- additive function so an older deployment never loses its health signal.
-- migration-execution: phased

-- Bound the trailing-window branch without blocking lifecycle writes. The
-- existing queued/running partial indexes cover active-state branches; this
-- one covers the only historical window the function is allowed to read.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_assurance_runs_slo_terminal_24h_idx
    ON campaign_assurance_runs (completed_at DESC, state)
    INCLUDE (gate_decision)
    WHERE completed_at IS NOT NULL
      AND state IN ('complete', 'incomplete', 'failed');

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    SELECT * INTO definer
      FROM pg_roles
     WHERE rolname = 'postwave_campaign_assurance_ops_definer';
    IF definer.oid IS NULL THEN
        RAISE EXCEPTION
            'migration 1938 Campaign Assurance ops definer is required';
    END IF;
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       definer.rolbypassrls THEN
        RAISE EXCEPTION
            'Campaign Assurance ops definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'Campaign Assurance ops definer must remain isolated';
    END IF;
    IF to_regprocedure(
           'public.ops_campaign_assurance_slo_health()'
       ) IS NOT NULL THEN
        RAISE EXCEPTION
            'Campaign Assurance SLO function exists out of band; remove and audit it before retrying';
    END IF;
END;
$$;

CREATE FUNCTION public.ops_campaign_assurance_slo_health()
RETURNS TABLE (
    queued_runs bigint,
    running_runs bigint,
    orphaned_queued_runs bigint,
    expired_running_leases bigint,
    ready_commands bigint,
    oldest_ready_command_age_seconds double precision,
    complete_runs_24h bigint,
    incomplete_runs_24h bigint,
    failed_runs_24h bigint,
    blocked_runs_24h bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
WITH run_rollup AS (
    SELECT
        count(*) FILTER (
            WHERE runs.state = 'queued'
        )::bigint AS queued_runs,
        count(*) FILTER (
            WHERE runs.state = 'running'
        )::bigint AS running_runs,
        count(*) FILTER (
            WHERE runs.state = 'queued'
              AND runs.snapshot_frozen_at IS NOT NULL
              AND runs.created_at <= statement_timestamp() - interval '5 minutes'
              AND (
                  runs.retry_not_before IS NULL OR
                  runs.retry_not_before <= statement_timestamp()
              )
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.campaign_assurance_commands AS commands
                   WHERE commands.tenant_id = runs.tenant_id
                     AND commands.run_id = runs.id
                     AND commands.completed_at IS NULL
              )
        )::bigint AS orphaned_queued_runs,
        count(*) FILTER (
            WHERE runs.state = 'running'
              AND runs.lease_expires_at <= statement_timestamp()
        )::bigint AS expired_running_leases,
        count(*) FILTER (
            WHERE runs.state = 'complete'
              AND runs.completed_at >= statement_timestamp() - interval '24 hours'
        )::bigint AS complete_runs_24h,
        count(*) FILTER (
            WHERE runs.state = 'incomplete'
              AND runs.completed_at >= statement_timestamp() - interval '24 hours'
        )::bigint AS incomplete_runs_24h,
        count(*) FILTER (
            WHERE runs.state = 'failed'
              AND runs.completed_at >= statement_timestamp() - interval '24 hours'
        )::bigint AS failed_runs_24h,
        count(*) FILTER (
            WHERE runs.state = 'complete'
              AND runs.gate_decision = 'block'
              AND runs.completed_at >= statement_timestamp() - interval '24 hours'
        )::bigint AS blocked_runs_24h
      FROM public.campaign_assurance_runs AS runs
     WHERE runs.state IN ('queued', 'running')
        OR (
            runs.state IN ('complete', 'incomplete', 'failed')
            AND runs.completed_at >=
                statement_timestamp() - interval '24 hours'
        )
), command_rollup AS (
    SELECT
        count(*) FILTER (
            WHERE commands.completed_at IS NULL
              AND commands.available_at <= statement_timestamp()
              AND (
                  commands.lease_expires_at IS NULL OR
                  commands.lease_expires_at <= statement_timestamp()
              )
        )::bigint AS ready_commands,
        COALESCE(
            max(
                extract(epoch FROM statement_timestamp() - commands.available_at)
            ) FILTER (
                WHERE commands.completed_at IS NULL
                  AND commands.available_at <= statement_timestamp()
                  AND (
                      commands.lease_expires_at IS NULL OR
                      commands.lease_expires_at <= statement_timestamp()
                  )
            ),
            0
        )::double precision AS oldest_ready_command_age_seconds
      FROM public.campaign_assurance_commands AS commands
)
SELECT run_rollup.queued_runs,
       run_rollup.running_runs,
       run_rollup.orphaned_queued_runs,
       run_rollup.expired_running_leases,
       command_rollup.ready_commands,
       command_rollup.oldest_ready_command_age_seconds,
       run_rollup.complete_runs_24h,
       run_rollup.incomplete_runs_24h,
       run_rollup.failed_runs_24h,
       run_rollup.blocked_runs_24h
  FROM run_rollup
 CROSS JOIN command_rollup;
$$;

ALTER FUNCTION public.ops_campaign_assurance_slo_health()
    OWNER TO postwave_campaign_assurance_ops_definer;

REVOKE ALL ON FUNCTION public.ops_campaign_assurance_slo_health()
    FROM PUBLIC, postwave_app, postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_slo_health()
    TO postwave_ops;

COMMENT ON FUNCTION public.ops_campaign_assurance_slo_health()
IS 'Content-free fleet aggregates for Campaign Assurance backlog, lease, and trailing-24h terminal SLO health.';

DO $$
DECLARE
    function_oid oid;
    definer_oid oid;
    ops_oid oid;
BEGIN
    SELECT to_regprocedure(
               'public.ops_campaign_assurance_slo_health()'
           )::oid
      INTO function_oid;
    SELECT oid INTO definer_oid
      FROM pg_roles
     WHERE rolname = 'postwave_campaign_assurance_ops_definer';
    SELECT oid INTO ops_oid
      FROM pg_roles
     WHERE rolname = 'postwave_ops';
    IF function_oid IS NULL OR definer_oid IS NULL OR ops_oid IS NULL THEN
        RAISE EXCEPTION 'Campaign Assurance SLO function or required role is missing';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS function
          JOIN pg_language AS language ON language.oid = function.prolang
         WHERE function.oid = function_oid
           AND (
               function.proowner <> definer_oid OR
               NOT function.prosecdef OR
               function.provolatile <> 's' OR
               function.prokind <> 'f' OR
               language.lanname <> 'sql' OR
               function.proconfig IS DISTINCT FROM
                   ARRAY['search_path=pg_catalog']::text[]
           )
    ) THEN
        RAISE EXCEPTION 'Campaign Assurance SLO function metadata is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS function
          CROSS JOIN LATERAL aclexplode(
              COALESCE(function.proacl, acldefault('f', function.proowner))
          ) AS acl
         WHERE function.oid = function_oid
           AND (
               acl.privilege_type <> 'EXECUTE' OR
               acl.grantee NOT IN (definer_oid, ops_oid) OR
               (acl.grantee = ops_oid AND acl.is_grantable)
           )
    ) OR (
        SELECT count(*)
          FROM pg_proc AS function
          CROSS JOIN LATERAL aclexplode(
              COALESCE(function.proacl, acldefault('f', function.proowner))
          ) AS acl
         WHERE function.oid = function_oid
           AND acl.grantee = ops_oid
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable
    ) <> 1 THEN
        RAISE EXCEPTION 'Campaign Assurance SLO function ACL is broader than reviewed';
    END IF;
    IF has_function_privilege(
           'postwave_app', function_oid, 'EXECUTE'
       ) OR NOT has_function_privilege(
           'postwave_ops', function_oid, 'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'Campaign Assurance SLO execute boundary is unsafe';
    END IF;
    IF has_table_privilege(
           'postwave_ops', 'public.campaign_assurance_runs', 'SELECT'
       ) OR has_table_privilege(
           'postwave_ops', 'public.campaign_assurance_commands', 'SELECT'
       ) THEN
        RAISE EXCEPTION
            'postwave_ops must not gain Campaign Assurance base-table SELECT';
    END IF;
END;
$$;

COMMIT;
