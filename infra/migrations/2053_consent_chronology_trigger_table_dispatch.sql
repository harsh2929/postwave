-- 2053_consent_chronology_trigger_table_dispatch.sql
--
-- Deleting a subscriber that owns a consent_records row failed with
--
--     ERROR: record "new" has no field "subject_type" (SQLSTATE 42703)
--
-- and so did every other UPDATE of consent_records. POST
-- /api/v1/subscribers/bulk/delete, the single-subscriber delete and a profile
-- merge all returned 500 for any contact that had ever been given consent.
--
-- Migration 1766 attached one trigger function,
-- public.subscriber_email_consent_stamp_chronology(), to two tables
-- (consent_events and consent_records) and guarded each table's immutability
-- list with a condition of the form
--
--     IF TG_TABLE_NAME = 'consent_events' AND (NEW.subject_type IS DISTINCT ...
--
-- PL/pgSQL hands that whole condition to the SQL executor as one expression and
-- resolves every NEW.<column> it names before any operand is evaluated. SQL
-- does not short-circuit AND for this purpose. On consent_records, which has no
-- subject_type column, the first UPDATE therefore raised 42703 before the table
-- test could exclude the branch.
--
-- consent_records_subscriber_id_fkey is ON DELETE SET NULL, so deleting a
-- subscriber issues exactly such an UPDATE (subscriber_id -> NULL) on every
-- consent record that referenced it.
--
-- The function is recreated with the table dispatch as its own statement: each
-- branch names only columns its table has, and PL/pgSQL never prepares the
-- other table's condition. The immutability contract itself is unchanged with
-- one deliberate, narrow exception: consent_records.subscriber_id may be
-- cleared (non-NULL -> NULL). That is the only change the SET NULL foreign key
-- makes, and it is how the schema already intends a consent record to outlive
-- its subscriber: the evidence row, its exact address and its chronology stay
-- intact while the dangling owner link is removed (subscribers/merge_satellites.go
-- relies on the same cascade). Re-pointing a record to a different subscriber,
-- or attaching an orphaned record to one, is still rejected. postwave_app holds
-- only INSERT and SELECT on both tables, so the cascade and SECURITY DEFINER
-- code are the only UPDATE paths this trigger polices.
--
-- A table that is not one of the two the function was written for now fails
-- closed on UPDATE instead of silently passing every change.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Retain the corrected function during application rollback;
-- older binaries are compatible. Re-applying the 1766 body would reinstate the
-- 42703 on every consent_records UPDATE and block subscriber deletion again.

BEGIN;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_stamp_chronology()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- The database clock, not a caller-supplied value, is the recording
        -- chronology.  Occurrence remains in created_at/captured_at.
        NEW.recorded_at := pg_catalog.clock_timestamp();
        RETURN NEW;
    END IF;

    -- Dispatch on the table in its own statement.  A condition that mixes the
    -- table test with NEW.<column> references is prepared as one expression,
    -- and preparing it resolves columns the other table does not have.
    IF TG_TABLE_NAME = 'consent_events' THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR
           NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR
           NEW.created_at IS DISTINCT FROM OLD.created_at OR
           NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
           NEW.subject_type IS DISTINCT FROM OLD.subject_type OR
           NEW.subject_id IS DISTINCT FROM OLD.subject_id OR
           NEW.subject_email IS DISTINCT FROM OLD.subject_email OR
           NEW.channel IS DISTINCT FROM OLD.channel OR
           NEW.category IS DISTINCT FROM OLD.category OR
           NEW.action IS DISTINCT FROM OLD.action OR
           NEW.source IS DISTINCT FROM OLD.source OR
           NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
           NEW.preferences IS DISTINCT FROM OLD.preferences OR
           NEW.proof_text IS DISTINCT FROM OLD.proof_text OR
           NEW.ip IS DISTINCT FROM OLD.ip OR
           NEW.user_agent IS DISTINCT FROM OLD.user_agent
        THEN
            RAISE EXCEPTION 'consent event terminal chronology and evidence are immutable'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'consent_records' THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR
           NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR
           NEW.created_at IS DISTINCT FROM OLD.created_at OR
           NEW.captured_at IS DISTINCT FROM OLD.captured_at OR
           NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
           -- Clearing the owner link is the ON DELETE SET NULL cascade; any
           -- other change of owner rewrites whose consent this record proves.
           (NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id AND
            NEW.subscriber_id IS NOT NULL) OR
           NEW.email IS DISTINCT FROM OLD.email OR
           NEW.channel IS DISTINCT FROM OLD.channel OR
           NEW.consent_status IS DISTINCT FROM OLD.consent_status OR
           NEW.source IS DISTINCT FROM OLD.source OR
           NEW.source_url IS DISTINCT FROM OLD.source_url OR
           NEW.form_id IS DISTINCT FROM OLD.form_id OR
           NEW.ip_addr IS DISTINCT FROM OLD.ip_addr OR
           NEW.user_agent IS DISTINCT FROM OLD.user_agent OR
           NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
           NEW.evidence IS DISTINCT FROM OLD.evidence
        THEN
            RAISE EXCEPTION 'consent record terminal chronology and evidence are immutable'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'subscriber_email_consent_stamp_chronology() has no immutability contract for table %',
            TG_TABLE_NAME
            USING ERRCODE = '0A000';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_stamp_chronology()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_stamp_chronology()
    TO postwave_app;

-- CREATE OR REPLACE keeps the function's OID, so both 1766 triggers still point
-- at it. Assert that rather than assume it: a missing or disabled trigger would
-- silently drop the recording chronology stamp.
DO $postcheck$
BEGIN
    IF (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_trigger
         WHERE tgname IN ('ab_1766_consent_events_recorded_chronology',
                          'ab_1766_consent_records_recorded_chronology')
           AND tgrelid IN ('public.consent_events'::pg_catalog.regclass,
                           'public.consent_records'::pg_catalog.regclass)
           AND tgfoid =
                   'public.subscriber_email_consent_stamp_chronology()'::pg_catalog.regprocedure
           AND tgenabled <> 'D'
           AND NOT tgisinternal
    ) <> 2 THEN
        RAISE EXCEPTION '2053 consent chronology triggers are not both bound to the recreated function'
            USING ERRCODE = '23514';
    END IF;
END;
$postcheck$;

COMMIT;
