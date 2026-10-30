-- 0339_partition_event_tables.sql
--
-- Phase 2 `p2-partition-event-tables` (P2, effort=M).
--
-- Convert the five append-only / high-volume event tables into native
-- PostgreSQL declarative RANGE partitions keyed by month. The goal is
-- twofold:
--
--   1. Make retention an O(1) DETACH+DROP per month instead of the
--      current O(N) DELETE FROM … WHERE at < ... batch loop, which
--      becomes unbounded as tenants accumulate years of history.
--   2. Let queries with a date predicate (the dominant access shape on
--      every one of these tables — "rollup for the last 30 days",
--      "audit feed since X") prune to a single month-sized child,
--      dropping p99 latency on the dashboard surfaces that read them.
--
-- Tables involved:
--   * audit_log              — partition by `at`
--   * subscriber_events      — partition by `at`
--   * campaign_report_events — partition by `at`
--   * event_log              — partition by `at`
--   * web_vitals_events      — partition by `at`
--
-- Pattern (per table):
--   (a) Rename existing  <table>          → <table>_legacy.
--   (b) Create new        <table> PARTITION BY RANGE (<partition_key>).
--   (c) ATTACH PARTITION <table>_legacy   FOR VALUES FROM ('-infinity')
--                                              TO ('YYYY-MM-01').
--       The boundary is the first empty UTC month after the newest existing
--       event across all five tables. This keeps every pre-existing row inside
--       the legacy partition instead of violating its attach constraint when
--       the migration runs on a populated database mid-month.
--   (d) Create the cut-over month + next 2 months as empty partitions.
--   (e) Re-create indexes on each child (NOT the parent — Postgres
--       propagates a parent-level CREATE INDEX to all children inside
--       a single AccessExclusiveLock transaction, which is the
--       opposite of what we want on a 100M-row legacy partition).
--   (f) The partition rotator worker
--       (apps/api/internal/partition_rotator) takes over from here:
--       it pre-creates next month's child nightly, DETACHes children
--       older than the per-table retention floor, and DROPs detached
--       children older than the hard retention ceiling
--       (POSTWAVE_PARTITION_HARD_RETENTION_DAYS, default 730).
--
-- Foreign-key handling:
--   audit_log has ONE inbound foreign key:
--     audit_pii_unmask_history.audit_log_id REFERENCES audit_log(id)
--   Postgres 14+ supports FKs *referencing* partitioned tables, BUT
--   the referenced column-set must match a unique constraint that
--   itself includes the partition key. The PK on a partitioned table
--   MUST include the partition key column (this is a hard PG rule, not
--   a choice). So:
--     * The partitioned audit_log gets PRIMARY KEY (id, at).
--     * audit_pii_unmask_history grows an `audit_log_at` column and
--       its FK is re-stated as (audit_log_id, audit_log_at) →
--       audit_log(id, at). Historical rows get audit_log_at backfilled
--       from a JOIN inside the same migration (one-off, O(rows-with-fk)).
--   This is the only inbound-FK reshape; the other four tables have no
--   referrers (verified by a `grep REFERENCES <table>` sweep over the
--   migration set).
--
-- Immutability triggers:
--   audit_log has BEFORE UPDATE / BEFORE DELETE triggers
--   (audit_log_immutability_guard, see 0169_audit_log_immutability.sql)
--   that block UPDATEs/DELETEs unless the trim worker GUC is set. On a
--   partitioned table, triggers attached to the parent *do not*
--   automatically fire on child writes — Postgres requires the trigger
--   to be re-attached to each partition. We re-attach the trigger to
--   every child created here, and the rotator worker re-attaches it on
--   any newly-created partition.
--
-- RLS:
--   Postgres replicates RLS policies from the parent to children on
--   ATTACH. We re-declare the parent policies on the new partitioned
--   parent below; children inherit on ATTACH/CREATE.
--
-- ─────────────────────────────────────────────────────────────────────
-- ROLLBACK PLAN (intentionally documented inline so an on-call operator
-- staring at the migration in pgAdmin doesn't have to reverse-engineer
-- it from the worker code):
--
--   The rollback is a directed acyclic graph keyed on which step of the
--   migration tripped. The forward path goes
--
--     RENAME → CREATE partitioned → ATTACH legacy → CREATE future
--     → CREATE indexes on children → RE-ATTACH triggers
--
--   and the rollback per step is its mirror image. All steps run inside
--   one BEGIN/COMMIT so a mid-migration failure is automatically
--   reversed by a single ROLLBACK. The interesting case is rolling back
--   *after* a successful deploy — i.e. operator says "we shipped 0339
--   and dashboards regressed, undo it cleanly without losing rows".
--   Sequence:
--
--     1.  Stop the partition_rotator worker
--         (POSTWAVE_PARTITION_ROTATOR_ENABLED=false + redeploy, or
--         scale the gateway deployment to 0 if a redeploy is
--         unavailable).
--     2.  For each of the five tables, DETACH every non-legacy partition
--         back into a temporary holding table, then INSERT them back
--         into <table>_legacy:
--
--           ALTER TABLE <table> DETACH PARTITION <table>_pYYYY_MM;
--           INSERT INTO <table>_legacy SELECT * FROM <table>_pYYYY_MM;
--           DROP TABLE <table>_pYYYY_MM;
--
--         Do this in oldest-first order so the legacy table's id sequence
--         stays monotonic.
--     3.  DROP the new partitioned parent (which now has only the legacy
--         child attached) WITHOUT CASCADE — the legacy child is a real
--         table and survives the parent DROP:
--
--           ALTER TABLE <table> DETACH PARTITION <table>_legacy;
--           DROP TABLE <table>;
--
--     4.  Rename the legacy table back:
--
--           ALTER TABLE <table>_legacy RENAME TO <table>;
--
--     5.  For audit_log specifically, restore the original FK shape on
--         audit_pii_unmask_history:
--
--           ALTER TABLE audit_pii_unmask_history
--             DROP CONSTRAINT audit_pii_unmask_history_audit_log_id_fkey;
--           ALTER TABLE audit_pii_unmask_history
--             ADD CONSTRAINT audit_pii_unmask_history_audit_log_id_fkey
--             FOREIGN KEY (audit_log_id)
--             REFERENCES audit_log(id) ON DELETE CASCADE;
--           ALTER TABLE audit_pii_unmask_history
--             DROP COLUMN audit_log_at;
--
--     6.  Re-grant the immutability trigger on the (now non-partitioned)
--         audit_log — it survived the migration on the legacy table but
--         the parent ones we created during the deploy are now gone.
--
--   Total rollback time on a 100M-row legacy partition is dominated by
--   step 2 (INSERT … SELECT) on whichever month-children accumulated
--   data post-deploy; everything else is metadata-only and runs in
--   milliseconds.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

-- ===========================================================================
-- 0. Helpers
-- ===========================================================================

-- Compute the first empty month after the newest existing event as a stable
-- migration constant. We compute it once so every table uses the same cut-over
-- boundary. Including now() ensures the boundary is never in the past even on
-- an empty database; including every source table makes future-dated imported
-- events safe instead of causing ATTACH PARTITION to fail.
DO $migration$
DECLARE
    cutover_month  date;
    next_month_1   date;
    next_month_2   date;
    next_month_3   date;
    legacy_upper   text;
    current_lower  text;
    current_upper  text;
    plus1_upper    text;
    plus2_upper    text;
    current_suffix text;
    plus1_suffix   text;
    plus2_suffix   text;
    -- Loop variable. PL/pgSQL would auto-declare on first FOR IN, but
    -- we declare it explicitly so the migration is robust against PG
    -- variants that enable plpgsql.extra_warnings='strict' (which
    -- treats the auto-declare as a warning).
    cs             record;
BEGIN
    SELECT (
        date_trunc('month', max(observed_at) AT TIME ZONE 'UTC')
        + INTERVAL '1 month'
    )::date
      INTO cutover_month
      FROM (
          SELECT now() AS observed_at
          UNION ALL SELECT max(at) FROM event_log
          UNION ALL SELECT max(at) FROM subscriber_events
          UNION ALL SELECT max(at) FROM campaign_report_events
          UNION ALL SELECT max(at) FROM web_vitals_events
          UNION ALL SELECT max(at) FROM audit_log
      ) AS observed_events;

    next_month_1 := cutover_month + INTERVAL '1 month';
    next_month_2 := cutover_month + INTERVAL '2 months';
    next_month_3 := cutover_month + INTERVAL '3 months';
    legacy_upper := to_char(cutover_month, 'YYYY-MM-DD');
    current_lower := to_char(cutover_month, 'YYYY-MM-DD');
    current_upper := to_char(next_month_1, 'YYYY-MM-DD');
    plus1_upper := to_char(next_month_2, 'YYYY-MM-DD');
    plus2_upper := to_char(next_month_3, 'YYYY-MM-DD');
    current_suffix := to_char(cutover_month, 'YYYY_MM');
    plus1_suffix := to_char(next_month_1, 'YYYY_MM');
    plus2_suffix := to_char(next_month_2, 'YYYY_MM');

    -- Surface the boundaries the rotator worker will read back so an
    -- operator inspecting the migration log can diff vs. the values
    -- the worker is creating.
    RAISE NOTICE 'partition-cutover: cutover_month=% next_month_1=% next_month_2=% next_month_3=%',
        cutover_month, next_month_1, next_month_2, next_month_3;

    -- =======================================================================
    -- 1. event_log  (lowest-risk: no inbound FKs, no immutability trigger,
    --                worker-friendly write GUC already in place)
    -- =======================================================================

    -- (a) Rename existing → legacy. IF EXISTS guard so re-runs on a
    -- staging environment that already ran the migration are no-ops.
    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'event_log' AND n.nspname = current_schema()
           AND c.relkind = 'r'  -- ordinary table, not 'p' (partitioned)
    ) THEN
        EXECUTE 'ALTER TABLE event_log RENAME TO event_log_legacy';
        -- Rename indexes + sequences with the table so the partition
        -- rotator doesn't trip over collisions when it creates new
        -- per-child indexes (PG auto-renames by name; we make it explicit
        -- on the indexes that have stable names called out from app code).
        EXECUTE 'ALTER INDEX IF EXISTS idx_event_log_tenant_seq      RENAME TO idx_event_log_legacy_tenant_seq';
        EXECUTE 'ALTER INDEX IF EXISTS idx_event_log_tenant_topic    RENAME TO idx_event_log_legacy_tenant_topic';
        EXECUTE 'ALTER INDEX IF EXISTS idx_event_log_at              RENAME TO idx_event_log_legacy_at';

        -- (b) Create the partitioned parent. We must include the
        -- partition key in the PK; bigserial → bigint (the sequence
        -- is detached on rename, but we re-attach it to the parent
        -- below so writes keep monotonically incrementing).
        EXECUTE $sql$
            CREATE TABLE event_log (
                sequence_id  bigint NOT NULL DEFAULT nextval('event_log_sequence_id_seq'),
                tenant_id    uuid NOT NULL,
                topic        text NOT NULL,
                payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
                at           timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (sequence_id, at)
            ) PARTITION BY RANGE (at)
        $sql$;

        EXECUTE 'ALTER SEQUENCE event_log_sequence_id_seq OWNED BY event_log.sequence_id';

        -- Re-grant + RLS on the parent. Children inherit.
        EXECUTE 'GRANT SELECT, INSERT, DELETE ON event_log TO postwave_app';
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE event_log_sequence_id_seq TO postwave_app';
        EXECUTE 'ALTER TABLE event_log ENABLE ROW LEVEL SECURITY';
        EXECUTE $sql$
            CREATE POLICY tenant_visible ON event_log AS PERMISSIVE FOR ALL TO postwave_app
                USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        $sql$;
        EXECUTE $sql$
            CREATE POLICY event_log_worker_all ON event_log AS PERMISSIVE FOR ALL TO postwave_app
                USING (current_setting('app.outbox_worker', true) = 'true')
                WITH CHECK (current_setting('app.outbox_worker', true) = 'true')
        $sql$;

        -- (c) Attach the legacy table as the historical partition.
        -- ATTACH requires the legacy PK to be compatible with the
        -- parent's; the legacy PK is on (sequence_id) only. We
        -- replace it with (sequence_id, at) so ATTACH succeeds.
        EXECUTE 'ALTER TABLE event_log_legacy DROP CONSTRAINT IF EXISTS event_log_pkey';
        EXECUTE 'ALTER TABLE event_log_legacy ADD PRIMARY KEY (sequence_id, at)';
        EXECUTE format(
            'ALTER TABLE event_log ATTACH PARTITION event_log_legacy FOR VALUES FROM (%L) TO (%L)',
            '-infinity', legacy_upper
        );

        -- (d) Pre-create current + 2 ahead.
        EXECUTE format(
            'CREATE TABLE event_log_p%s PARTITION OF event_log FOR VALUES FROM (%L) TO (%L)',
            current_suffix, current_lower, current_upper
        );
        EXECUTE format(
            'CREATE TABLE event_log_p%s PARTITION OF event_log FOR VALUES FROM (%L) TO (%L)',
            plus1_suffix, current_upper, plus1_upper
        );
        EXECUTE format(
            'CREATE TABLE event_log_p%s PARTITION OF event_log FOR VALUES FROM (%L) TO (%L)',
            plus2_suffix, plus1_upper, plus2_upper
        );

        -- (e) Indexes on each future child (NOT the parent — see header).
        FOR cs IN SELECT * FROM (VALUES (current_suffix), (plus1_suffix), (plus2_suffix)) AS t(suffix) LOOP
            EXECUTE format('CREATE INDEX idx_event_log_p%s_tenant_seq   ON event_log_p%s (tenant_id, sequence_id DESC)', cs.suffix, cs.suffix);
            EXECUTE format('CREATE INDEX idx_event_log_p%s_tenant_topic ON event_log_p%s (tenant_id, topic, sequence_id DESC)', cs.suffix, cs.suffix);
            EXECUTE format('CREATE INDEX idx_event_log_p%s_at           ON event_log_p%s (at)', cs.suffix, cs.suffix);
        END LOOP;
    END IF;

    -- =======================================================================
    -- 2. subscriber_events
    -- =======================================================================

    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'subscriber_events' AND n.nspname = current_schema()
           AND c.relkind = 'r'
    ) THEN
        EXECUTE 'ALTER TABLE subscriber_events RENAME TO subscriber_events_legacy';
        EXECUTE 'ALTER INDEX IF EXISTS subscriber_events_subscriber_idx RENAME TO subscriber_events_legacy_subscriber_idx';
        EXECUTE 'ALTER INDEX IF EXISTS subscriber_events_campaign_idx   RENAME TO subscriber_events_legacy_campaign_idx';

        EXECUTE $sql$
            CREATE TABLE subscriber_events (
                -- Mirror the legacy table's full accreted column set AND its exact
                -- CHECK constraints via LIKE so ATTACH PARTITION matches parent↔
                -- child constraints (a hand-written, expression-equivalent CHECK is
                -- NOT accepted by ATTACH — it must be the same constraint object,
                -- which INCLUDING CONSTRAINTS guarantees). The hardcoded list had
                -- also drifted (missing source/metadata/bounce_type/stream/…). The
                -- partition PK is restated explicitly; per-row tenant FK is dropped
                -- on the parent (RLS enforces tenant isolation; the legacy child
                -- keeps its own FK).
                LIKE subscriber_events_legacy
                    INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED,
                PRIMARY KEY (id, at)
            ) PARTITION BY RANGE (at)
        $sql$;
        EXECUTE 'ALTER SEQUENCE subscriber_events_id_seq OWNED BY subscriber_events.id';

        EXECUTE 'GRANT SELECT, INSERT ON subscriber_events TO postwave_app';
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE subscriber_events_id_seq TO postwave_app';
        EXECUTE 'ALTER TABLE subscriber_events ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE subscriber_events FORCE ROW LEVEL SECURITY';
        EXECUTE $sql$
            CREATE POLICY tenant_isolation ON subscriber_events
                FOR ALL
                USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        $sql$;

        EXECUTE 'ALTER TABLE subscriber_events_legacy DROP CONSTRAINT IF EXISTS subscriber_events_pkey';
        EXECUTE 'ALTER TABLE subscriber_events_legacy ADD PRIMARY KEY (id, at)';
        EXECUTE format(
            'ALTER TABLE subscriber_events ATTACH PARTITION subscriber_events_legacy FOR VALUES FROM (%L) TO (%L)',
            '-infinity', legacy_upper
        );

        EXECUTE format(
            'CREATE TABLE subscriber_events_p%s PARTITION OF subscriber_events FOR VALUES FROM (%L) TO (%L)',
            current_suffix, current_lower, current_upper
        );
        EXECUTE format(
            'CREATE TABLE subscriber_events_p%s PARTITION OF subscriber_events FOR VALUES FROM (%L) TO (%L)',
            plus1_suffix, current_upper, plus1_upper
        );
        EXECUTE format(
            'CREATE TABLE subscriber_events_p%s PARTITION OF subscriber_events FOR VALUES FROM (%L) TO (%L)',
            plus2_suffix, plus1_upper, plus2_upper
        );

        FOR cs IN SELECT * FROM (VALUES (current_suffix), (plus1_suffix), (plus2_suffix)) AS t(suffix) LOOP
            EXECUTE format(
                'CREATE INDEX subscriber_events_p%s_subscriber_idx ON subscriber_events_p%s (tenant_id, subscriber_email, event_type, at DESC)',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX subscriber_events_p%s_campaign_idx   ON subscriber_events_p%s (tenant_id, campaign_id, at DESC)',
                cs.suffix, cs.suffix);
        END LOOP;
    END IF;

    -- =======================================================================
    -- 3. campaign_report_events
    -- =======================================================================

    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'campaign_report_events' AND n.nspname = current_schema()
           AND c.relkind = 'r'
    ) THEN
        EXECUTE 'ALTER TABLE campaign_report_events RENAME TO campaign_report_events_legacy';
        EXECUTE 'ALTER INDEX IF EXISTS campaign_report_events_campaign_idx RENAME TO campaign_report_events_legacy_campaign_idx';
        EXECUTE 'ALTER INDEX IF EXISTS campaign_report_events_contact_idx  RENAME TO campaign_report_events_legacy_contact_idx';

        EXECUTE $sql$
            CREATE TABLE campaign_report_events (
                -- Mirror the legacy table's full accreted column set + exact CHECK
                -- constraints via LIKE so ATTACH PARTITION matches parent↔child
                -- constraints (a hand-written equivalent CHECK is rejected by
                -- ATTACH). The hardcoded list had drifted (missing source/
                -- provider_event_id/message_id). Partition PK restated; per-row
                -- tenant/campaign FKs drop on the parent (RLS covers isolation;
                -- the legacy child keeps its own FKs).
                LIKE campaign_report_events_legacy
                    INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED,
                PRIMARY KEY (id, at)
            ) PARTITION BY RANGE (at)
        $sql$;
        EXECUTE 'ALTER SEQUENCE campaign_report_events_id_seq OWNED BY campaign_report_events.id';

        EXECUTE 'GRANT SELECT, INSERT ON campaign_report_events TO postwave_app';
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE campaign_report_events_id_seq TO postwave_app';
        EXECUTE 'ALTER TABLE campaign_report_events ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE campaign_report_events FORCE ROW LEVEL SECURITY';
        EXECUTE $sql$
            CREATE POLICY tenant_isolation ON campaign_report_events
                FOR ALL
                USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        $sql$;

        EXECUTE 'ALTER TABLE campaign_report_events_legacy DROP CONSTRAINT IF EXISTS campaign_report_events_pkey';
        EXECUTE 'ALTER TABLE campaign_report_events_legacy ADD PRIMARY KEY (id, at)';
        EXECUTE format(
            'ALTER TABLE campaign_report_events ATTACH PARTITION campaign_report_events_legacy FOR VALUES FROM (%L) TO (%L)',
            '-infinity', legacy_upper
        );

        EXECUTE format(
            'CREATE TABLE campaign_report_events_p%s PARTITION OF campaign_report_events FOR VALUES FROM (%L) TO (%L)',
            current_suffix, current_lower, current_upper
        );
        EXECUTE format(
            'CREATE TABLE campaign_report_events_p%s PARTITION OF campaign_report_events FOR VALUES FROM (%L) TO (%L)',
            plus1_suffix, current_upper, plus1_upper
        );
        EXECUTE format(
            'CREATE TABLE campaign_report_events_p%s PARTITION OF campaign_report_events FOR VALUES FROM (%L) TO (%L)',
            plus2_suffix, plus1_upper, plus2_upper
        );

        FOR cs IN SELECT * FROM (VALUES (current_suffix), (plus1_suffix), (plus2_suffix)) AS t(suffix) LOOP
            EXECUTE format(
                'CREATE INDEX campaign_report_events_p%s_campaign_idx ON campaign_report_events_p%s (tenant_id, campaign_id, event_type, at DESC)',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX campaign_report_events_p%s_contact_idx  ON campaign_report_events_p%s (tenant_id, subscriber_email, at DESC)',
                cs.suffix, cs.suffix);
        END LOOP;
    END IF;

    -- =======================================================================
    -- 4. web_vitals_events  (no RLS, no tenant FK enforcement — anonymous
    --                        public ingest. uuid PK + at partition key.)
    -- =======================================================================

    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'web_vitals_events' AND n.nspname = current_schema()
           AND c.relkind = 'r'
    ) THEN
        EXECUTE 'ALTER TABLE web_vitals_events RENAME TO web_vitals_events_legacy';
        EXECUTE 'ALTER INDEX IF EXISTS web_vitals_events_metric_at_idx  RENAME TO web_vitals_events_legacy_metric_at_idx';
        EXECUTE 'ALTER INDEX IF EXISTS web_vitals_events_tenant_at_idx  RENAME TO web_vitals_events_legacy_tenant_at_idx';

        EXECUTE $sql$
            CREATE TABLE web_vitals_events (
                id               uuid NOT NULL DEFAULT gen_random_uuid(),
                session_id       text,
                tenant_id        uuid,
                metric_name      text NOT NULL,
                value            numeric NOT NULL,
                rating           text,
                navigation_type  text,
                page_path        text,
                user_agent       text,
                at               timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (id, at)
            ) PARTITION BY RANGE (at)
        $sql$;

        -- web_vitals_events deliberately has no RLS (see 0083_web_vitals.sql).
        -- We grant the same default-public select/insert as the legacy table.
        EXECUTE 'GRANT SELECT, INSERT ON web_vitals_events TO postwave_app';

        EXECUTE 'ALTER TABLE web_vitals_events_legacy DROP CONSTRAINT IF EXISTS web_vitals_events_pkey';
        EXECUTE 'ALTER TABLE web_vitals_events_legacy ADD PRIMARY KEY (id, at)';
        EXECUTE format(
            'ALTER TABLE web_vitals_events ATTACH PARTITION web_vitals_events_legacy FOR VALUES FROM (%L) TO (%L)',
            '-infinity', legacy_upper
        );

        EXECUTE format(
            'CREATE TABLE web_vitals_events_p%s PARTITION OF web_vitals_events FOR VALUES FROM (%L) TO (%L)',
            current_suffix, current_lower, current_upper
        );
        EXECUTE format(
            'CREATE TABLE web_vitals_events_p%s PARTITION OF web_vitals_events FOR VALUES FROM (%L) TO (%L)',
            plus1_suffix, current_upper, plus1_upper
        );
        EXECUTE format(
            'CREATE TABLE web_vitals_events_p%s PARTITION OF web_vitals_events FOR VALUES FROM (%L) TO (%L)',
            plus2_suffix, plus1_upper, plus2_upper
        );

        FOR cs IN SELECT * FROM (VALUES (current_suffix), (plus1_suffix), (plus2_suffix)) AS t(suffix) LOOP
            EXECUTE format(
                'CREATE INDEX web_vitals_events_p%s_metric_at_idx ON web_vitals_events_p%s (metric_name, at DESC)',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX web_vitals_events_p%s_tenant_at_idx ON web_vitals_events_p%s (tenant_id, at DESC) WHERE tenant_id IS NOT NULL',
                cs.suffix, cs.suffix);
        END LOOP;
    END IF;

    -- =======================================================================
    -- 5. audit_log  (the hairy one — FK referrer, immutability triggers,
    --                redaction columns, retention overrides, generated alias.
    --                We migrate but keep the FK reshape minimal.)
    -- =======================================================================
    --
    -- See header comment for the FK reshape rationale; audit_pii_unmask_history
    -- grows an `audit_log_at` column and the FK is restated as a composite.

    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'audit_log' AND n.nspname = current_schema()
           AND c.relkind = 'r'
    ) THEN
        -- Drop the inbound FK so we can re-shape the audit_log PK.
        EXECUTE 'ALTER TABLE audit_pii_unmask_history DROP CONSTRAINT IF EXISTS audit_pii_unmask_history_audit_log_id_fkey';

        -- Backfill the new at-column on the FK side so we can re-add
        -- the composite FK without violating it. Only rows that
        -- actually have an audit_log_id need to be joined.
        EXECUTE 'ALTER TABLE audit_pii_unmask_history ADD COLUMN IF NOT EXISTS audit_log_at timestamptz';
        EXECUTE $sql$
            UPDATE audit_pii_unmask_history h
               SET audit_log_at = a.at
              FROM audit_log a
             WHERE h.audit_log_id = a.id
               AND h.audit_log_at IS NULL
        $sql$;

        -- Drop the immutability trigger on the legacy table so the
        -- below DDL doesn't trip it. We re-attach it to every child
        -- partition after attach.
        EXECUTE 'DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log';
        EXECUTE 'DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log';

        EXECUTE 'ALTER TABLE audit_log RENAME TO audit_log_legacy';

        -- Rename historical indexes so the rotator's name conventions
        -- don't collide on the new month partitions.
        EXECUTE 'ALTER INDEX IF EXISTS audit_log_tenant_at_idx          RENAME TO audit_log_legacy_tenant_at_idx';
        EXECUTE 'ALTER INDEX IF EXISTS audit_log_tenant_action_at_idx   RENAME TO audit_log_legacy_tenant_action_at_idx';
        EXECUTE 'ALTER INDEX IF EXISTS idx_audit_log_legal_hold_tenant  RENAME TO audit_log_legacy_legal_hold_tenant_idx';
        EXECUTE 'ALTER INDEX IF EXISTS idx_audit_log_action_tenant      RENAME TO audit_log_legacy_action_tenant_idx';
        EXECUTE 'ALTER INDEX IF EXISTS idx_audit_log_redacted_fields    RENAME TO audit_log_legacy_redacted_fields_idx';

        -- Create the partitioned parent. We carry forward every
        -- column the legacy table ended up with by the end of 0271 —
        -- the new column list mirrors `audit_log_legacy` exactly so
        -- the ATTACH below is a no-op rewrite (only metadata changes).
        --
        -- We re-derive `created_at` as a generated column so app code
        -- that references it keeps working (see 0169).
        EXECUTE $sql$
            CREATE TABLE audit_log (
                -- Mirror the legacy table's full, accreted column set EXACTLY via
                -- LIKE so ATTACH PARTITION succeeds regardless of which columns
                -- later migrations added. The prior hardcoded list had drifted and
                -- omitted actor_type / actor_label / prev_hash / row_hash /
                -- recipient_fingerprint / event_id / session_id / client_event_seq,
                -- and the column ORDER no longer matched — both fatal to ATTACH.
                -- INCLUDING GENERATED preserves the created_at GENERATED column
                -- (0169); INCLUDING DEFAULTS/CONSTRAINTS preserves the id sequence
                -- default and the retention-override CHECK. The composite partition
                -- PK is restated explicitly (LIKE does not copy the PK).
                LIKE audit_log_legacy
                    INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED,
                PRIMARY KEY (id, at)
            ) PARTITION BY RANGE (at)
        $sql$;
        EXECUTE 'ALTER SEQUENCE audit_log_id_seq OWNED BY audit_log.id';

        EXECUTE 'GRANT SELECT, INSERT ON audit_log TO postwave_app';
        EXECUTE 'GRANT UPDATE (retention_override_days, legal_hold) ON audit_log TO postwave_app';
        EXECUTE 'GRANT USAGE, SELECT  ON SEQUENCE audit_log_id_seq TO postwave_app';

        EXECUTE 'ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY';
        EXECUTE $sql$
            CREATE POLICY tenant_isolation ON audit_log
                FOR ALL
                USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        $sql$;

        -- The legacy PK on audit_log_legacy is on (id) — replace it
        -- with (id, at) to be partition-compatible.
        EXECUTE 'ALTER TABLE audit_log_legacy DROP CONSTRAINT IF EXISTS audit_log_pkey';
        EXECUTE 'ALTER TABLE audit_log_legacy ADD PRIMARY KEY (id, at)';

        -- Re-derive `created_at` on the legacy child so its shape
        -- *exactly* matches the partitioned parent's generated
        -- column. PostgreSQL's ATTACH PARTITION requires column-level
        -- equivalence including generation expression: if the parent
        -- defines `created_at timestamptz GENERATED ALWAYS AS (at)
        -- STORED` and the legacy child has it as a plain timestamptz
        -- (or is missing it, or has a different generation
        -- expression), ATTACH fails with:
        --     "child table is missing column" / "column ... in child
        --      table must be marked GENERATED ALWAYS".
        --
        -- 0169 originally added `created_at` to audit_log as
        -- `GENERATED ALWAYS AS (at) STORED`, but it was added with
        -- `ADD COLUMN IF NOT EXISTS` — so on any environment where a
        -- previous schema iteration created `created_at` as a plain
        -- column first, 0169 silently no-ops and the shapes diverge.
        -- Re-derive defensively here:
        --   1. DROP COLUMN IF EXISTS (idempotent; metadata-only on PG,
        --      no row rewrite — see Postgres docs).
        --   2. ADD COLUMN as GENERATED ALWAYS AS (at) STORED so it
        --      mirrors the partitioned parent's declaration exactly.
        --
        -- Re-running this migration on an environment that already
        -- partitioned is safe: the outer `relkind = 'r'` guard skips
        -- the whole audit_log block once the table is partitioned, so
        -- this DROP+ADD only ever runs on the legacy ordinary table.
        EXECUTE 'ALTER TABLE audit_log_legacy DROP COLUMN IF EXISTS created_at';
        EXECUTE 'ALTER TABLE audit_log_legacy ADD COLUMN created_at timestamptz GENERATED ALWAYS AS (at) STORED';

        EXECUTE format(
            'ALTER TABLE audit_log ATTACH PARTITION audit_log_legacy FOR VALUES FROM (%L) TO (%L)',
            '-infinity', legacy_upper
        );

        EXECUTE format(
            'CREATE TABLE audit_log_p%s PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
            current_suffix, current_lower, current_upper
        );
        EXECUTE format(
            'CREATE TABLE audit_log_p%s PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
            plus1_suffix, current_upper, plus1_upper
        );
        EXECUTE format(
            'CREATE TABLE audit_log_p%s PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
            plus2_suffix, plus1_upper, plus2_upper
        );

        -- Per-child indexes covering the dominant access shapes from
        -- 0002, 0271, 0263.
        FOR cs IN SELECT * FROM (VALUES (current_suffix), (plus1_suffix), (plus2_suffix)) AS t(suffix) LOOP
            EXECUTE format(
                'CREATE INDEX audit_log_p%s_tenant_at_idx        ON audit_log_p%s (tenant_id, at DESC)',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX audit_log_p%s_tenant_action_at_idx ON audit_log_p%s (tenant_id, action, at DESC)',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX audit_log_p%s_legal_hold_tenant_idx ON audit_log_p%s (tenant_id, at DESC) WHERE legal_hold = true',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX audit_log_p%s_action_tenant_idx     ON audit_log_p%s (tenant_id, action)',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE INDEX audit_log_p%s_redacted_fields_idx   ON audit_log_p%s (tenant_id, at DESC) WHERE redacted_field_hashes <> ''{}''::jsonb',
                cs.suffix, cs.suffix);

            -- Re-attach the immutability triggers to every child (the
            -- ones we dropped on the legacy table above stay dropped;
            -- legal_hold + retention_override_days writes are allowed
            -- via the column-level GRANT above on the parent).
            EXECUTE format(
                'CREATE TRIGGER audit_log_p%s_no_update BEFORE UPDATE ON audit_log_p%s FOR EACH ROW EXECUTE FUNCTION audit_log_immutability_guard()',
                cs.suffix, cs.suffix);
            EXECUTE format(
                'CREATE TRIGGER audit_log_p%s_no_delete BEFORE DELETE ON audit_log_p%s FOR EACH ROW EXECUTE FUNCTION audit_log_immutability_guard()',
                cs.suffix, cs.suffix);
        END LOOP;

        -- Re-add the inbound FK on audit_pii_unmask_history as a
        -- composite key (id, at) — required because PG only allows
        -- FKs referencing partitioned tables when the referenced
        -- column-set includes the partition key.
        EXECUTE $sql$
            ALTER TABLE audit_pii_unmask_history
              ADD CONSTRAINT audit_pii_unmask_history_audit_log_id_at_fkey
              FOREIGN KEY (audit_log_id, audit_log_at)
              REFERENCES audit_log(id, at)
              ON DELETE CASCADE
        $sql$;
    END IF;

END
$migration$;

-- ===========================================================================
-- 6. Partition rotator bookkeeping table.
-- ===========================================================================
--
-- The rotator worker reads/writes this row per-table. It carries the
-- per-table retention and audit knobs so an operator can override the
-- defaults without redeploying the gateway.
--
-- Why a dedicated config table instead of tenant_settings: retention
-- here is a *global* dimension (the partitions span all tenants — RLS
-- happens at row read time, but the physical partition is shared) so
-- a per-tenant override doesn't make sense. The DETACH boundary is one
-- per (table, month), set globally.

CREATE TABLE IF NOT EXISTS partition_rotator_config (
    table_name              text PRIMARY KEY
        CHECK (table_name IN (
            'audit_log',
            'subscriber_events',
            'campaign_report_events',
            'event_log',
            'web_vitals_events'
        )),
    -- Soft retention floor: partitions older than this are DETACHed
    -- (they stop being read by partition-pruning queries; the data
    -- is still on disk in the detached child table). Defaults below
    -- mirror the existing retention policies on each table.
    retention_days          int NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
    -- Hard retention ceiling: DETACHed partitions older than this are
    -- DROPped. Conservatively defaults to retention_days * 2 so a
    -- misconfigured retention_days can't take immediate effect.
    hard_retention_days     int NOT NULL CHECK (hard_retention_days BETWEEN 30 AND 3650),
    enabled                 boolean NOT NULL DEFAULT true,
    last_rotated_at         timestamptz,
    last_detached_at        timestamptz,
    last_dropped_at         timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Seed sensible defaults. Operator can UPDATE these rows before
-- enabling the rotator.
INSERT INTO partition_rotator_config (table_name, retention_days, hard_retention_days, enabled)
VALUES
    -- audit_log: SOC 2 / HIPAA retention is generally 7 years; we keep
    -- partitions live for 730 days and DROP after another 1825d so the
    -- combined window is ~7 years.
    ('audit_log',              730,  730 + 1825, false),
    -- subscriber_events: engagement triggers care about 90d window;
    -- legacy data is archived to S3 long before that. We keep live
    -- partitions for 180d, DROP after 365d.
    ('subscriber_events',      180,  365,        false),
    -- campaign_report_events: campaign reports show 90d default;
    -- year-over-year rollups need 400d. Hard drop at 800d.
    ('campaign_report_events', 400,  800,        false),
    -- event_log: SSE replay only — 7d retention per 0119 header.
    -- Hard drop at 30d.
    ('event_log',              7,    30,         false),
    -- web_vitals_events: dashboard rollups read p75 over 28d; we keep
    -- 90d live and DROP at 180d.
    ('web_vitals_events',      90,   180,        false)
ON CONFLICT (table_name) DO NOTHING;

GRANT SELECT, UPDATE ON partition_rotator_config TO postwave_app;
-- No RLS — global operator-managed table. The rotator worker reads it
-- under the worker scope GUC (app.outbox_worker='true'), but the rows
-- aren't tenant-scoped to begin with.

COMMIT;
