-- 2046_drop_duplicate_tenant_cascade_paths.sql
--
-- Forward-only correction to migration 2045, which gave fifteen tenant tables a
-- direct ON DELETE CASCADE FK to tenants(id). Twelve of those tables were
-- already bound to their tenant. Each has a validated ON DELETE CASCADE
-- composite FK into a parent row. Every column of that FK is NOT NULL, the
-- table's tenant_id is one of them, and it references the parent's tenant_id.
-- The parent is itself bound to tenants. So the composite FK already rejects a
-- tenant_id that names no tenant, because it must equal the parent's. It also
-- deletes the row when its tenant is deleted, because the parent row cascades
-- first. The 2045 comment says otherwise; that claim was wrong for these
-- twelve. The direct FK added nothing except a second cascade path from
-- tenants, and that path breaks tenant deletion:
--
--   Eleven of the twelve tables carry a BEFORE DELETE guard that allows a
--   DELETE only after the owning root row is gone:
--     campaign_assurance_snapshot_guard, campaign_assurance_worker_evidence_guard,
--     campaign_assurance_overrides_guard, campaign_assurance_model_invocation_guard
--     and campaign_assurance_progress_events_append_only (root:
--     campaign_assurance_runs), ai_regression_run_examples_guard (root:
--     ai_regression_runs) and campaign_send_delivery_events_immutable_guard
--     (root: campaigns).
--   PostgreSQL runs FK cascades one level at a time. Deleting a tenant first
--   runs one RI trigger for each FK that references tenants, in trigger-name
--   order (RI_ConstraintTrigger_a_<oid>, compared as text). Only after all of
--   them have run does it run the cascades those deletes queued. Before 2045,
--   these rows were at level two or deeper, and every root has its own tenants
--   FK, so every root row was gone before any guard ran. The 2045 FK moved
--   the rows to level one, next to their roots. Whether a guard still finds
--   its root then depends on the digits of the trigger OIDs. If a 2045 trigger
--   sorts before its root's trigger, deleting a tenant that owns assurance
--   evidence, raw-delivery events or ai-regression examples fails with
--   SQLSTATE 55000 and rolls back. A fresh replay happens to order the
--   triggers safely; a restored or long-lived cluster need not.
--
-- This migration drops those twelve direct FKs, so each table is again deleted
-- only through its parent. automation_lifecycle_event_dispatches has no guard.
-- Its direct FK is dropped as well because it duplicates
-- automation_lifecycle_dispatch_inbox_fkey exactly: when tenant_id is part of
-- the parent key, the table is bound through the parent. Keeping that one rule
-- means a guard added later cannot reopen the hazard.
--
-- chat_delivery_log, engagement_honeypot_fetches and landing_page_versions
-- keep their 2045 FK. It is their only ownership edge, and none of them has a
-- DELETE guard.
--
-- scripts/lint-migrations-schema.py now accepts this transitive binding: a
-- validated ON DELETE CASCADE FK whose columns are all NOT NULL and which maps
-- the table's tenant_id onto the parent's tenant_id, to a parent that is bound
-- directly or in the same way. scripts/lint-migrations-baseline.json records
-- the twelve tables with the transitive-tenant-binding disposition, and the
-- verifier fails if a direct tenants FK comes back on any of them.
--
-- Locks. Dropping an FK takes ACCESS EXCLUSIVE on its table and on the table
-- it references, here tenants, which the request path reads. The first DROP
-- would take tenants and then keep it while each later DROP waited for its own
-- table, so one busy evidence table would stall every tenants read. The
-- migration therefore locks the twelve tables first, in one fixed order, and
-- tenants last. While it waits for an evidence table, tenants is still free.
-- While it waits for tenants, new tenants readers queue behind the request,
-- and lock_timeout (5s) bounds that stall. Once tenants is granted, nothing is
-- left to wait for: the drops and the self-audit change and read only the
-- catalog, and COMMIT releases every lock. A lock timeout, or a deadlock with
-- a concurrent tenant deletion (which locks these tables and tenants in both
-- orders), rolls the whole transaction back with every FK still in place, and
-- the migration can be run again.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Keep the direct FKs dropped when a previous application
-- image is restored. No binary relies on them: the composite FKs enforce the
-- same tenant_id and delete the same rows. Re-adding them would bring back the
-- trigger-order failure of tenant deletion described above.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Every table the DROPs below alter, in the order they appear, then tenants.
LOCK TABLE
    public.ai_regression_run_examples,
    public.automation_lifecycle_event_dispatches,
    public.campaign_assurance_extractions,
    public.campaign_assurance_findings,
    public.campaign_assurance_model_invocation_reservations,
    public.campaign_assurance_model_invocation_results,
    public.campaign_assurance_overrides,
    public.campaign_assurance_progress_events,
    public.campaign_assurance_run_artifacts,
    public.campaign_assurance_run_configurations,
    public.campaign_assurance_run_targets,
    public.campaign_send_delivery_events
    IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.tenants IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.ai_regression_run_examples
    DROP CONSTRAINT IF EXISTS ai_regression_run_examples_tenant_id_fkey;
ALTER TABLE public.automation_lifecycle_event_dispatches
    DROP CONSTRAINT IF EXISTS automation_lifecycle_event_dispatches_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_extractions
    DROP CONSTRAINT IF EXISTS campaign_assurance_extractions_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_findings
    DROP CONSTRAINT IF EXISTS campaign_assurance_findings_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_model_invocation_reservations
    DROP CONSTRAINT IF EXISTS campaign_assurance_model_invocation_reservations_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_model_invocation_results
    DROP CONSTRAINT IF EXISTS campaign_assurance_model_invocation_results_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_overrides
    DROP CONSTRAINT IF EXISTS campaign_assurance_overrides_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_progress_events
    DROP CONSTRAINT IF EXISTS campaign_assurance_progress_events_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_run_artifacts
    DROP CONSTRAINT IF EXISTS campaign_assurance_run_artifacts_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_run_configurations
    DROP CONSTRAINT IF EXISTS campaign_assurance_run_configurations_tenant_id_fkey;
ALTER TABLE public.campaign_assurance_run_targets
    DROP CONSTRAINT IF EXISTS campaign_assurance_run_targets_tenant_id_fkey;
ALTER TABLE public.campaign_send_delivery_events
    DROP CONSTRAINT IF EXISTS campaign_send_delivery_events_tenant_id_fkey;

-- Self-audit. Fail the transaction rather than record a version whose promised
-- state is not the effective state. For each table: no FK to tenants remains,
-- the reviewed composite FK binds tenant_id to the parent's tenant_id, and the
-- chain of parents ends at a table with exactly one direct, validated,
-- cascading tenants FK.
DO $$
DECLARE
    children text[] := ARRAY[
        'ai_regression_run_examples',
        'automation_lifecycle_event_dispatches',
        'campaign_assurance_extractions',
        'campaign_assurance_findings',
        'campaign_assurance_model_invocation_reservations',
        'campaign_assurance_model_invocation_results',
        'campaign_assurance_overrides',
        'campaign_assurance_progress_events',
        'campaign_assurance_run_artifacts',
        'campaign_assurance_run_configurations',
        'campaign_assurance_run_targets',
        'campaign_send_delivery_events'
    ];
    bindings text[] := ARRAY[
        'ai_regression_run_examples_run_fk',
        'automation_lifecycle_dispatch_inbox_fkey',
        'campaign_assurance_extractions_target_fk',
        'campaign_assurance_findings_target_fk',
        'campaign_assurance_model_reservations_run_fk',
        'campaign_assurance_model_results_reservation_fk',
        'campaign_assurance_overrides_run_fk',
        'campaign_assurance_progress_events_run_fk',
        'campaign_assurance_run_artifacts_run_fk',
        'campaign_assurance_run_configurations_run_fk',
        'campaign_assurance_run_targets_artifact_fk',
        'campaign_send_delivery_events_delivery_fk'
    ];
    parents text[] := ARRAY[
        'ai_regression_runs',
        'automation_lifecycle_event_inbox',
        'campaign_assurance_run_targets',
        'campaign_assurance_run_targets',
        'campaign_assurance_runs',
        'campaign_assurance_model_invocation_reservations',
        'campaign_assurance_runs',
        'campaign_assurance_runs',
        'campaign_assurance_runs',
        'campaign_assurance_runs',
        'campaign_assurance_run_artifacts',
        'campaign_send_deliveries'
    ];
    idx integer;
    walked text;
    hops integer;
BEGIN
    FOR idx IN 1 .. cardinality(children) LOOP
        IF EXISTS (
            SELECT 1
              FROM pg_catalog.pg_constraint
             WHERE conrelid = ('public.' || children[idx])::regclass
               AND contype = 'f'
               AND confrelid = 'public.tenants'::regclass
        ) THEN
            RAISE EXCEPTION
                'migration 2046: % still has a direct FK to tenants', children[idx];
        END IF;

        IF NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_constraint AS c
             WHERE c.conrelid = ('public.' || children[idx])::regclass
               AND c.conname = bindings[idx]
               AND c.contype = 'f'
               AND c.convalidated
               AND c.confdeltype = 'c'
               AND c.confrelid = ('public.' || parents[idx])::regclass
               AND NOT EXISTS (
                   SELECT 1
                     FROM unnest(c.conkey) AS key(attnum)
                     JOIN pg_catalog.pg_attribute AS a
                       ON a.attrelid = c.conrelid
                      AND a.attnum = key.attnum
                    WHERE NOT a.attnotnull
               )
               AND EXISTS (
                   SELECT 1
                     FROM unnest(c.conkey, c.confkey) AS key(child_attnum, parent_attnum)
                     JOIN pg_catalog.pg_attribute AS child_column
                       ON child_column.attrelid = c.conrelid
                      AND child_column.attnum = key.child_attnum
                     JOIN pg_catalog.pg_attribute AS parent_column
                       ON parent_column.attrelid = c.confrelid
                      AND parent_column.attnum = key.parent_attnum
                    WHERE child_column.attname = 'tenant_id'
                      AND parent_column.attname = 'tenant_id'
               )
        ) THEN
            RAISE EXCEPTION
                'migration 2046: % is not bound to %.tenant_id by a validated, cascading, NOT NULL FK %',
                children[idx], parents[idx], bindings[idx];
        END IF;
    END LOOP;

    FOR idx IN 1 .. cardinality(children) LOOP
        walked := parents[idx];
        hops := 0;
        LOOP
            EXIT WHEN (
                SELECT count(*) = 1
                   AND count(*) FILTER (
                       WHERE c.convalidated
                         AND c.confdeltype = 'c'
                         AND c.conkey = ARRAY[a.attnum]::smallint[]
                         AND c.confkey = ARRAY[(
                             SELECT id_column.attnum
                               FROM pg_catalog.pg_attribute AS id_column
                              WHERE id_column.attrelid = 'public.tenants'::regclass
                                AND id_column.attname = 'id'
                                AND NOT id_column.attisdropped
                         )]::smallint[]
                         AND a.attnotnull
                   ) = 1
                  FROM pg_catalog.pg_constraint AS c
                  JOIN pg_catalog.pg_attribute AS a
                    ON a.attrelid = c.conrelid
                   AND a.attname = 'tenant_id'
                   AND NOT a.attisdropped
                 WHERE c.conrelid = ('public.' || walked)::regclass
                   AND c.contype = 'f'
                   AND c.confrelid = 'public.tenants'::regclass
            );
            IF array_position(children, walked) IS NULL OR hops >= cardinality(children) THEN
                RAISE EXCEPTION
                    'migration 2046: the parent chain of % does not end at a direct tenants FK (stopped at %)',
                    children[idx], walked;
            END IF;
            walked := parents[array_position(children, walked)];
            hops := hops + 1;
        END LOOP;
    END LOOP;
END
$$;

COMMIT;
