-- 1703_ops_action_runs.sql
-- Ops-console action executor (Plan 3, Task 1).
-- Spec: docs/superpowers/specs/2026-07-11-ops-console-design.md ("Actions").
--
-- Two things live here:
--
-- 1) ops_action_runs — the idempotency ledger for operator actions. One row
--    per invocation, keyed by a client-supplied idempotency key: a
--    double-click replays the stored result instead of re-running the action
--    (rule 2 of the spec: "A double-click must not double-pay an affiliate").
--    A row that stays 'running' forever is a crashed action made visible.
--    PLATFORM table (no tenant dimension) — listed in
--    PLATFORM_TABLE_ALLOWLIST in scripts/lint-migrations.sh.
--
-- 2) The audit_log platform-operator lane. The spec requires every operator
--    action to land in audit_log with actor_type = 'platform_operator', but
--    the schema made that impossible: the actor_type CHECK only admitted
--    human|agent|system, and tenant_id was NOT NULL — a fleet-level action
--    (e.g. "replay the Stripe DLQ") has no tenant to attribute. So:
--      - tenant_id becomes nullable. RLS keeps NULL-tenant rows invisible to
--        every tenant session (tenant_id = <GUC> is never true for NULL), so
--        platform rows can never leak into a tenant's audit UI.
--      - actor_type CHECK gains 'platform_operator'.
--      - postwave_ops gets INSERT (and only INSERT: it cannot read the audit
--        trail, tenant rows or otherwise) plus an INSERT policy that ONLY
--        admits tenant-less platform_operator rows. The ops role therefore
--        cannot forge a tenant-attributed audit row, and no other role can
--        write a tenant-less one.
--    The actor_type CHECK is re-added as plain (validating) DDL: every
--    pre-existing row satisfied the strictly narrower old constraint, and the
--    nightly live-migration rehearsal times the partition scan.
--
-- rollback-strategy: no-op - additive table, grants, one policy, and two
-- audit_log loosenings (nullable column, wider CHECK) that old code never
-- exercises; redeploy the previous image and drop ops_action_runs.

BEGIN;

CREATE TABLE IF NOT EXISTS ops_action_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    check_id        text NOT NULL,
    action_id       text NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    operator_email  text NOT NULL,
    input           jsonb NOT NULL DEFAULT 'null'::jsonb,
    status          text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    result          text NOT NULL DEFAULT '',
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ops_action_runs_check_started_idx
    ON ops_action_runs (check_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE ON ops_action_runs TO postwave_ops;

-- ---- audit_log platform-operator lane ----

ALTER TABLE audit_log ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
    CHECK (actor_type IN ('human', 'agent', 'system', 'platform_operator'));

GRANT INSERT ON audit_log TO postwave_ops;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO postwave_ops;

-- Permissive policies OR together per role: for postwave_ops this policy is
-- the only one that can pass (the tenant_isolation policy needs the tenant
-- GUC, which ops connections never set), and it only passes for exactly the
-- row shape the ops console writes.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename  = 'audit_log'
           AND policyname = 'ops_platform_audit'
    ) THEN
        CREATE POLICY ops_platform_audit ON audit_log
            FOR INSERT TO postwave_ops
            WITH CHECK (tenant_id IS NULL AND actor_type = 'platform_operator');
    END IF;
END
$$;

COMMIT;
