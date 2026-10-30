-- 0351_partition_parents_fk.sql
--
-- Phase 4 `p4a-mig-0339-add-fk` (critical, effort=S).
--
-- Restore the tenant_id -> tenants(id) ON DELETE CASCADE foreign key on the
-- partitioned parent tables introduced by 0339. 0339 re-creates audit_log,
-- event_log, subscriber_events and campaign_report_events as partitioned
-- parents; the parent definitions do not (re)declare the per-row tenant FK, so
-- it must be (re)established here so the constraint propagates to every current
-- child and every future partition the rotator materialises.
--
-- web_vitals_events is intentionally skipped (anonymous public ingest, nullable
-- tenant_id, no RLS, no FK by design — see 0083 and 0339 section 4).
--
-- Why VALID, not the NOT VALID + VALIDATE two-phase pattern:
--   PostgreSQL REJECTS `ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID` on a
--   partitioned table (SQLSTATE 42809 — "cannot add NOT VALID foreign key on
--   partitioned table"). The FK must be added as VALID, at which point Postgres
--   recurses it to every partition. On empty / fresh tables this is instant; on
--   large prod tables it takes the scan once (acceptable for a constraint that
--   was meant to exist all along).
--
-- Why we drop pre-existing tenant FKs first:
--   The legacy partitions (the renamed originals attached by 0339) retain their
--   own pre-cutover tenant FK, whose name collides with the constraint the
--   partitioned-parent ADD would clone onto each child. Dropping any existing
--   tenant FK on the parent and its partitions first makes the ADD clean and
--   keeps the migration idempotent across re-runs / partial deploys.

BEGIN;

DO $$
DECLARE
    tbl  text;
    con  record;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['audit_log','event_log','subscriber_events','campaign_report_events'] LOOP
        -- Act only on the partitioned parent. If the table is missing or 0339
        -- has not run (relkind <> 'p'), there is nothing to converge here.
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = tbl AND n.nspname = current_schema() AND c.relkind = 'p'
        ) THEN
            CONTINUE;
        END IF;

        -- Drop every existing tenant->tenants FK on the parent and on each of
        -- its partitions, so the fresh partitioned-parent ADD can't collide.
        FOR con IN
            SELECT pc.oid::regclass AS rel, c.conname
              FROM pg_constraint c
              JOIN pg_class pc ON pc.oid = c.conrelid
              JOIN pg_class ft ON ft.oid = c.confrelid
             WHERE c.contype = 'f'
               AND ft.relname = 'tenants'
               AND (pc.relname = tbl
                    OR pc.oid IN (SELECT inhrelid FROM pg_inherits
                                   WHERE inhparent = to_regclass(tbl)))
        LOOP
            EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', con.rel, con.conname);
        END LOOP;

        -- Add the tenant FK on the partitioned parent (VALID → recurses to all
        -- partitions).
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I '
            'FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
            tbl, tbl || '_tenant_id_fkey');
    END LOOP;
END
$$;

COMMIT;
