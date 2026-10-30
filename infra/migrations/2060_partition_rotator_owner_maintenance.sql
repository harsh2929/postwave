-- 2060_partition_rotator_owner_maintenance.sql
--
-- The partition rotator has never been able to do its job, and on
-- 2027-01-01 every insert into the five partitioned event tables fails.
--
-- The rotator (apps/api/internal/partition_rotator) runs inside the API as
-- postwave_app and used to issue its DDL directly: CREATE TABLE … PARTITION
-- OF, CREATE INDEX and CREATE TRIGGER on the new child, ALTER TABLE … DETACH
-- PARTITION and DROP TABLE. postwave_app has neither CREATE on schema public
-- (PostgreSQL 15 took it away from PUBLIC) nor ownership of the partitioned
-- parents, and PostgreSQL requires both:
--
--   ERROR:  permission denied for schema public
--   ERROR:  must be owner of table audit_log   (once CREATE is granted)
--
-- So each nightly tick logged "ensure partition failed" and created nothing.
-- Migration 0339 pre-created the month it ran in plus two; on a database
-- migrated in autumn 2026 the newest children are audit_log_p2026_12,
-- subscriber_events_p2026_12, campaign_report_events_p2026_12,
-- event_log_p2026_12 and web_vitals_events_p2026_12, and there is no default
-- partition. From 2027-01-01 audit writes, engagement events, report events,
-- the SSE replay log and web-vitals samples all fail with "no partition of
-- relation … found for row". DETACH and DROP failed the same way, so no
-- retention window has ever been applied either.
--
-- Granting postwave_app CREATE on public and ownership of the parents would
-- hand the RLS-bound application role general DDL power, and the children it
-- created would be its own: owned, without row-level security, readable
-- across every tenant. Instead the table owner does the work. Three SECURITY
-- DEFINER functions, owned by the role running this migration (the owner of
-- the partitioned tables), perform exactly the rotator's three operations on
-- exactly the five rotated tables, and postwave_app may only EXECUTE them:
--
--   * partition_rotator_ensure_month(table, month) creates the month's child
--     with the per-child indexes 0339 gives every child and, for audit_log,
--     its immutability triggers. Additive and idempotent, and only for last
--     month through twelve months ahead: each call locks the parent, so the
--     application role cannot fill the catalog with far-future months.
--   * partition_rotator_detach(table, child) detaches an attached month child
--     whose whole month is older than the table's retention_days.
--   * partition_rotator_drop_detached(table, child) drops a detached month
--     child whose month is older than hard_retention_days.
--
-- The two destructive functions do not take the caller's word for the
-- retention window. They read it from partition_rotator_config, which this
-- migration makes operator-managed: postwave_app keeps UPDATE only on the
-- bookkeeping timestamps it writes, not on retention_days, hard_retention_days
-- or enabled. audit_log also has a floor no configuration lowers — nothing
-- younger than 730 days is detached or dropped, the SOC 2 floor the Go worker
-- already applied — and a child still holding legal_hold rows is never
-- dropped. The application role cannot delete audit rows (the immutability
-- triggers refuse); these functions must not become the way around that.
--
-- Partition bounds are date literals read in the session TimeZone, as 0339's
-- and the old rotator's were, so new children stay contiguous with the ones
-- already there.
--
-- Finally the migration itself creates the current month through six months
-- ahead for all five tables, so a database that runs this migration is safe
-- before any new API image starts its first rotator tick.
--
-- apps/api/internal/partition_rotator/rotator_db_test.go runs the rotator as
-- postwave_app with its clock in November 2026 and checks that the January
-- 2027 children exist, belong to the table owner, carry the indexes and
-- triggers, and accept an audit insert through the parent; and that the
-- destructive functions refuse live, legal-hold and misnamed children.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Keep the functions, the tightened grant and the created
-- children when a previous application image is restored. That image issues
-- its own DDL as postwave_app, which fails exactly as before this migration;
-- the children created here are ordinary empty partitions it can write
-- through. Dropping them would bring the 2027-01-01 insert failures back.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── partition_rotator_config: retention is operator-managed ──────────────

REVOKE UPDATE ON public.partition_rotator_config FROM postwave_app;
GRANT UPDATE (last_rotated_at, last_detached_at, last_dropped_at, updated_at)
    ON public.partition_rotator_config TO postwave_app;

-- ─── shared validation ─────────────────────────────────────────────────────

-- The month a rotator child covers, parsed from its name
-- (<table>_pYYYY_MM), or an exception. Only the five rotated tables and only
-- that exact naming convention are accepted; _legacy children never are.
CREATE OR REPLACE FUNCTION public.partition_rotator_child_month(p_table text, p_child text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_table IS NULL OR p_table NOT IN (
        'audit_log', 'subscriber_events', 'campaign_report_events', 'event_log', 'web_vitals_events'
    ) THEN
        RAISE EXCEPTION 'partition rotator: % is not a rotated table', p_table
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_child IS NULL OR p_child !~ ('^' || p_table || '_p[0-9]{4}_(0[1-9]|1[0-2])$') THEN
        RAISE EXCEPTION 'partition rotator: % is not a month child of %', p_child, p_table
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN to_date(right(p_child, 7), 'YYYY_MM');
END;
$$;

REVOKE ALL ON FUNCTION public.partition_rotator_child_month(text, text) FROM PUBLIC;

-- ─── create ────────────────────────────────────────────────────────────────

-- Creating or detaching a partition locks more than the parent: PostgreSQL
-- clones the parent's foreign keys onto the child, which takes SHARE ROW
-- EXCLUSIVE on every table on the other side of one (tenants, and for
-- audit_log also audit_pii_unmask_history), and it takes them AFTER the
-- parent's ACCESS EXCLUSIVE. A request that writes a tenant and then its audit
-- row locks the same two tables the other way round, so the two deadlock and
-- PostgreSQL aborts one of them -- possibly the request.
--
-- This takes every one of those locks first, in one fixed order: the tables
-- the foreign keys touch (the order in which requests take them: the tenant,
-- then its audit row), then the parent alone (ONLY: CREATE and DETACH need no
-- lock on the other children). The callers' lock_timeout is kept under
-- PostgreSQL's 1s deadlock_timeout, so if some other ordering still closes a
-- cycle, the rotator's wait expires before any request's deadlock check runs:
-- the rotator gives up (55P03) and retries; the request never fails for it.
CREATE OR REPLACE FUNCTION public.partition_rotator_lock_for_ddl(p_table text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_parent regclass := ('public.' || quote_ident(p_table))::regclass;
    v_related regclass;
BEGIN
    FOR v_related IN
        SELECT r.rel FROM (
            SELECT confrelid AS rel FROM pg_catalog.pg_constraint
             WHERE contype = 'f' AND conrelid = v_parent AND conparentid = 0
            UNION
            SELECT conrelid FROM pg_catalog.pg_constraint
             WHERE contype = 'f' AND confrelid = v_parent AND conparentid = 0
        ) AS r
         WHERE r.rel <> v_parent
         ORDER BY r.rel
    LOOP
        EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', v_related);
    END LOOP;
    EXECUTE format('LOCK TABLE ONLY %s IN ACCESS EXCLUSIVE MODE', v_parent);
END;
$$;

CREATE OR REPLACE FUNCTION public.partition_rotator_ensure_month(p_table text, p_month date)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '500ms'
AS $$
DECLARE
    v_child text;
    v_upper date;
    v_covered boolean;
    v_overlaps boolean;
BEGIN
    IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
        RAISE EXCEPTION 'partition rotator: % is not the first day of a month', p_month
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- The rotator asks for this month and the next few (LeadMonths). Nothing
    -- else is its job, and each call takes an ACCESS EXCLUSIVE lock on the
    -- parent and adds a table and its indexes to the catalog, so the
    -- application role must not be able to ask for '9999-12-01', or for every
    -- month for years. Last month stays allowed for a clock that trails the
    -- database's at a month boundary; a real backfill of past months is an
    -- operator's job, done as the table owner.
    IF p_month < (date_trunc('month', now()) - interval '1 month')::date
       OR p_month > (date_trunc('month', now()) + interval '12 months')::date THEN
        RAISE EXCEPTION 'partition rotator: % is outside the months the rotator creates (last month to twelve months ahead)', p_month
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_child := p_table || '_p' || to_char(p_month, 'YYYY_MM');
    -- Validates the table against the allow-list and the name we built.
    PERFORM public.partition_rotator_child_month(p_table, v_child);
    IF to_regclass('public.' || quote_ident(v_child)) IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits
                    WHERE inhrelid = to_regclass('public.' || quote_ident(v_child))
                      AND inhparent = ('public.' || quote_ident(p_table))::regclass) THEN
            RETURN false;
        END IF;
        -- A detached child of this month is still on disk (the retention
        -- window between DETACH and DROP): creating nothing would leave the
        -- month with no partition, and creating another is impossible.
        RAISE EXCEPTION 'partition rotator: % exists but is not attached to %', v_child, p_table
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    v_upper := (p_month + interval '1 month')::date;

    PERFORM public.partition_rotator_lock_for_ddl(p_table);

    -- A month another partition already holds (the _legacy child spans
    -- everything before 0339's cutover) needs nothing. A month another
    -- partition holds only in part is a misconfiguration CREATE would reject
    -- anyway; say which. Bounds are compared as timestamptz, the column type.
    SELECT COALESCE(bool_or(b.lower <= p_month::timestamptz AND b.upper >= v_upper::timestamptz), false),
           COALESCE(bool_or(b.lower < v_upper::timestamptz AND b.upper > p_month::timestamptz), false)
      INTO v_covered, v_overlaps
      FROM (
            SELECT CASE WHEN m[1] = 'MINVALUE' THEN '-infinity'::timestamptz
                        ELSE btrim(m[1], '''')::timestamptz END AS lower,
                   CASE WHEN m[2] = 'MAXVALUE' THEN 'infinity'::timestamptz
                        ELSE btrim(m[2], '''')::timestamptz END AS upper
              FROM pg_catalog.pg_inherits i
              JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
             CROSS JOIN LATERAL regexp_match(
                       pg_catalog.pg_get_expr(c.relpartbound, c.oid),
                       '^FOR VALUES FROM \((MINVALUE|''[^'']*'')\) TO \((MAXVALUE|''[^'']*'')\)$') AS m
             WHERE i.inhparent = ('public.' || quote_ident(p_table))::regclass
               AND m IS NOT NULL
           ) AS b;
    IF v_covered THEN
        RETURN false;
    END IF;
    IF v_overlaps THEN
        RAISE EXCEPTION 'partition rotator: an existing partition of % covers part of %', p_table, p_month
            USING ERRCODE = 'invalid_object_definition';
    END IF;

    EXECUTE format('CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
                   v_child, p_table, p_month, v_upper);

    -- The per-child indexes 0339 gives every child; the parents carry only
    -- their primary keys, which PostgreSQL attaches to the child itself.
    CASE p_table
    WHEN 'audit_log' THEN
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, at DESC)', v_child || '_tenant_at_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, action, at DESC)', v_child || '_tenant_action_at_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, at DESC) WHERE legal_hold = true', v_child || '_legal_hold_tenant_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, action)', v_child || '_action_tenant_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, at DESC) WHERE redacted_field_hashes <> ''{}''::jsonb', v_child || '_redacted_fields_idx', v_child);
        -- audit_log's immutability guard is attached per child (see 0339).
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutability_guard()', v_child || '_no_update', v_child);
        EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutability_guard()', v_child || '_no_delete', v_child);
    WHEN 'subscriber_events' THEN
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, subscriber_email, event_type, at DESC)', v_child || '_subscriber_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, campaign_id, at DESC)', v_child || '_campaign_idx', v_child);
    WHEN 'campaign_report_events' THEN
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, campaign_id, event_type, at DESC)', v_child || '_campaign_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, subscriber_email, at DESC)', v_child || '_contact_idx', v_child);
    WHEN 'event_log' THEN
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, sequence_id DESC)', 'idx_' || v_child || '_tenant_seq', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, topic, sequence_id DESC)', 'idx_' || v_child || '_tenant_topic', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (at)', 'idx_' || v_child || '_at', v_child);
    WHEN 'web_vitals_events' THEN
        EXECUTE format('CREATE INDEX %I ON public.%I (metric_name, at DESC)', v_child || '_metric_at_idx', v_child);
        EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, at DESC) WHERE tenant_id IS NOT NULL', v_child || '_tenant_at_idx', v_child);
    END CASE;
    RETURN true;
END;
$$;

-- ─── detach ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partition_rotator_detach(p_table text, p_child text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
-- DETACH (not CONCURRENTLY: that cannot run in a function) waits for ACCESS
-- EXCLUSIVE on the parent, and every insert into the parent queues behind that
-- wait. Retiring an old month can wait for the next nightly run; inserts
-- should not wait long for it, and the wait must end before PostgreSQL's 1s
-- deadlock check (see partition_rotator_lock_for_ddl).
SET lock_timeout = '500ms'
AS $$
DECLARE
    v_month date := public.partition_rotator_child_month(p_table, p_child);
    v_month_end timestamptz;
    v_retention_days integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE i.inhparent = ('public.' || quote_ident(p_table))::regclass
           AND n.nspname = 'public'
           AND c.relname = p_child
    ) THEN
        RETURN false;
    END IF;
    SELECT retention_days INTO STRICT v_retention_days
      FROM public.partition_rotator_config WHERE table_name = p_table;
    v_month_end := (v_month + interval '1 month')::date;
    IF v_month_end > date_trunc('month', now()) - make_interval(days => v_retention_days) THEN
        RAISE EXCEPTION 'partition rotator: % is inside the % day retention window of %',
                        p_child, v_retention_days, p_table
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF p_table = 'audit_log' AND v_month_end > now() - interval '730 days' THEN
        RAISE EXCEPTION 'partition rotator: % is inside the 730 day audit retention floor', p_child
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM public.partition_rotator_lock_for_ddl(p_table);
    EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', p_table, p_child);
    RETURN true;
END;
$$;

-- ─── drop ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partition_rotator_drop_detached(p_table text, p_child text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
-- As for detach: dropping can wait for the next run.
SET lock_timeout = '1s'
AS $$
DECLARE
    v_month date := public.partition_rotator_child_month(p_table, p_child);
    v_child regclass := to_regclass('public.' || quote_ident(p_child));
    v_hard_retention_days integer;
    v_held boolean;
BEGIN
    IF v_child IS NULL THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid = v_child)
       OR (SELECT relkind FROM pg_catalog.pg_class WHERE oid = v_child) <> 'r' THEN
        RAISE EXCEPTION 'partition rotator: % is still attached; detach it first', p_child
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT hard_retention_days INTO STRICT v_hard_retention_days
      FROM public.partition_rotator_config WHERE table_name = p_table;
    IF v_month >= date_trunc('month', now()) - make_interval(days => v_hard_retention_days) THEN
        RAISE EXCEPTION 'partition rotator: % is inside the % day hard retention window of %',
                        p_child, v_hard_retention_days, p_table
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF p_table = 'audit_log' THEN
        IF (v_month + interval '1 month')::date > now() - interval '730 days' THEN
            RAISE EXCEPTION 'partition rotator: % is inside the 730 day audit retention floor', p_child
                USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE legal_hold)', p_child) INTO v_held;
        IF v_held THEN
            RAISE EXCEPTION 'partition rotator: % holds audit rows under legal hold', p_child
                USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
    END IF;
    EXECUTE format('DROP TABLE public.%I', p_child);
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.partition_rotator_lock_for_ddl(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.partition_rotator_ensure_month(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.partition_rotator_detach(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.partition_rotator_drop_detached(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partition_rotator_ensure_month(text, date) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.partition_rotator_detach(text, text) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.partition_rotator_drop_detached(text, text) TO postwave_app;

COMMENT ON FUNCTION public.partition_rotator_ensure_month(text, date) IS
    'Creates the month child of a rotated event table (audit_log, subscriber_events, '
    'campaign_report_events, event_log, web_vitals_events) as the table owner, with the '
    'per-child indexes and, for audit_log, the immutability triggers. Returns false when '
    'the child already exists. Called by the partition rotator as postwave_app, which '
    'has no DDL privileges of its own (migration 2060).';
COMMENT ON FUNCTION public.partition_rotator_detach(text, text) IS
    'Detaches an attached month child whose month is older than the table''s configured '
    'retention_days, and for audit_log older than 730 days. Refuses anything else.';
COMMENT ON FUNCTION public.partition_rotator_drop_detached(text, text) IS
    'Drops a detached month child older than the table''s configured hard_retention_days, '
    'never an audit_log child younger than 730 days or holding legal_hold rows.';

-- ─── heal now ──────────────────────────────────────────────────────────────

-- The current month and six ahead, for every rotated table: half a year of
-- runway past the rotator's two-month lead, before any new image runs. Months
-- that already have a child (or sit inside _legacy) are left alone.
SELECT public.partition_rotator_ensure_month(t.table_name, m.month::date)
  FROM (VALUES ('audit_log'), ('subscriber_events'), ('campaign_report_events'),
               ('event_log'), ('web_vitals_events')) AS t(table_name)
 CROSS JOIN generate_series(date_trunc('month', now()),
                            date_trunc('month', now()) + interval '6 months',
                            interval '1 month') AS m(month);

COMMIT;
