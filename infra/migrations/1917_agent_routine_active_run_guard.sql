-- 1917_agent_routine_active_run_guard.sql
--
-- A routine execution is detached after POST /run returns 202. Before this
-- guard, two replicas could open two `running` receipts for the same routine,
-- and deleting the routine could cascade-delete the in-flight ledger row.
--
-- This migration makes one running receipt per tenant/routine a database
-- invariant and refuses routine UPDATE/DELETE while that receipt is active.
-- The update guard is the stable-configuration boundary: Execute may safely
-- read the routine after Start because its prompt, target, approval policy and
-- name cannot change until the receipt becomes terminal.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: retain the active-run guard during application rollback;
-- older code is compatible with the stricter invariant. Remove both triggers,
-- both functions, and the partial unique index only after every deployed
-- writer has an equivalent exclusion/ledger guarantee. Terminalized duplicate
-- receipts are intentionally retained as honest interruption records.

BEGIN;

-- Close the deployment window before reconciling historical duplicates and
-- building the partial unique index. This trigger serializes every transition
-- into `running` on the parent routine row, so an older writer cannot create a
-- new duplicate while CREATE INDEX CONCURRENTLY is in progress.
CREATE OR REPLACE FUNCTION agent_routine_runs_refuse_duplicate_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.status <> 'running' THEN
        RETURN NEW;
    END IF;

    PERFORM 1
      FROM public.agent_routines AS routine
     WHERE routine.tenant_id = NEW.tenant_id
       AND routine.id = NEW.routine_id
     FOR UPDATE;

    IF EXISTS (
        SELECT 1
          FROM public.agent_routine_runs AS active_run
         WHERE active_run.tenant_id = NEW.tenant_id
           AND active_run.routine_id = NEW.routine_id
           AND active_run.status = 'running'
           AND active_run.id <> NEW.id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'routine has an active run',
            CONSTRAINT = 'agent_routine_runs_one_active_guard';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_routine_runs_one_active_guard ON agent_routine_runs;
CREATE TRIGGER agent_routine_runs_one_active_guard
    BEFORE INSERT OR UPDATE OF tenant_id, routine_id, status
    ON agent_routine_runs
    FOR EACH ROW
    EXECUTE FUNCTION agent_routine_runs_refuse_duplicate_active();

-- Reconcile any pre-existing duplicate active receipts before installing the
-- unique index. Keep the oldest receipt as the owner and fail every later
-- duplicate without exposing provider or tenant content.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY tenant_id, routine_id
               ORDER BY started_at ASC, id ASC
           ) AS active_rank
      FROM agent_routine_runs
     WHERE status = 'running'
)
UPDATE agent_routine_runs AS run
   SET status = 'failed',
       error = 'routine execution was interrupted before completion',
       finished_at = COALESCE(run.finished_at, now())
  FROM ranked
 WHERE run.id = ranked.id
   AND ranked.active_rank > 1;

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_routine_runs_one_active_idx
    ON agent_routine_runs (tenant_id, routine_id)
    WHERE status = 'running';

BEGIN;

CREATE OR REPLACE FUNCTION agent_routines_refuse_active_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.agent_routine_runs AS active_run
         WHERE active_run.tenant_id = OLD.tenant_id
           AND active_run.routine_id = OLD.id
           AND active_run.status = 'running'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'routine has an active run',
            CONSTRAINT = 'agent_routines_active_run_guard';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_routines_active_run_guard ON agent_routines;
CREATE TRIGGER agent_routines_active_run_guard
    BEFORE UPDATE OR DELETE ON agent_routines
    FOR EACH ROW
    EXECUTE FUNCTION agent_routines_refuse_active_mutation();

COMMIT;
