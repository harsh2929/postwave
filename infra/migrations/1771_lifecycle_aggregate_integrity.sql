-- 1771_lifecycle_aggregate_integrity.sql
--
-- Lifecycle is part of the subscriber aggregate.  The original sidecar and
-- history tables each referenced subscriber_id globally but did not prove that
-- their copied tenant_id belonged to the same subscriber.  In addition, the
-- shared set_updated_at() trigger uses transaction-start now(); a transaction
-- that began early and waited on a subscriber lock could therefore move the
-- aggregate revision backwards after a later-started writer committed.
--
-- This migration installs a subscriber-specific monotonic revision trigger and
-- validates the tenant/stage/source/reason invariants used by the API and
-- automation boundary.
--
-- rollback-strategy: no-op
-- rollback-details: stricter aggregate integrity and monotonic revisions are
-- safe for older binaries; reverting would re-open stale-write ambiguity.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.subscribers_set_updated_at_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    old_user_custom_fields jsonb := COALESCE(OLD.custom_fields, '{}'::jsonb) - '_listmonk_id';
    new_user_custom_fields jsonb := COALESCE(NEW.custom_fields, '{}'::jsonb) - '_listmonk_id';
    -- Stored generated columns are NULL in NEW during a BEFORE trigger. Exclude
    -- search_tsv from the durable source-field comparison; PostgreSQL rebuilds
    -- it after this trigger from the otherwise unchanged source columns.
    old_visible_row jsonb := to_jsonb(OLD) - 'updated_at' - 'custom_fields' - 'search_tsv' - 'pii_scan_revision';
    new_visible_row jsonb := to_jsonb(NEW) - 'updated_at' - 'custom_fields' - 'search_tsv' - 'pii_scan_revision';
BEGIN
    -- Preserve migration 1758's API concurrency contract: the asynchronous
    -- engine-link marker is internal-only and must not immediately invalidate
    -- the ETag returned by the preceding user-visible write. The earlier PII
    -- trigger also advances its internal scan revision when custom_fields
    -- changes, so that derived watermark is excluded from this visible-row
    -- comparison. Any simultaneous durable delta, including another custom-
    -- field key, still advances the aggregate revision monotonically.
    IF new_user_custom_fields = old_user_custom_fields
       AND new_visible_row = old_visible_row
       AND (NEW.custom_fields -> '_listmonk_id')
           IS DISTINCT FROM (OLD.custom_fields -> '_listmonk_id')
    THEN
        NEW.updated_at := OLD.updated_at;
    ELSE
        NEW.updated_at := GREATEST(
            pg_catalog.clock_timestamp(),
            OLD.updated_at + interval '1 microsecond'
        );
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscribers_set_updated_at_monotonic()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribers_set_updated_at_monotonic()
    TO postwave_app;

DROP TRIGGER IF EXISTS subscribers_set_updated_at ON public.subscribers;
CREATE TRIGGER subscribers_set_updated_at
    BEFORE UPDATE ON public.subscribers
    FOR EACH ROW
    EXECUTE FUNCTION public.subscribers_set_updated_at_monotonic();

ALTER TABLE public.subscriber_lifecycle
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_tenant_subscriber_fkey;
ALTER TABLE public.subscriber_lifecycle
    ADD CONSTRAINT subscriber_lifecycle_tenant_subscriber_fkey
    FOREIGN KEY (tenant_id, subscriber_id)
    REFERENCES public.subscribers (tenant_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_tenant_subscriber_fkey;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_tenant_subscriber_fkey
    FOREIGN KEY (tenant_id, subscriber_id)
    REFERENCES public.subscribers (tenant_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_previous_stage_check;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_previous_stage_check
    CHECK (
        previous_stage IS NULL OR previous_stage IN (
            'subscriber', 'lead', 'mql', 'sql', 'opportunity',
            'customer', 'evangelist', 'other'
        )
    ) NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_next_stage_check;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_next_stage_check
    CHECK (next_stage IN (
        'subscriber', 'lead', 'mql', 'sql', 'opportunity',
        'customer', 'evangelist', 'other'
    )) NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_actual_transition_check;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_actual_transition_check
    CHECK (previous_stage IS NULL OR previous_stage <> next_stage)
    NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_source_check;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_source_check
    CHECK (source ~ '^[a-zA-Z0-9_.:-]{1,64}$')
    NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_reason_check;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_reason_check
    CHECK (
        pg_catalog.char_length(reason) <= 500
        AND pg_catalog.octet_length(reason) <= 2048
        AND reason !~ '[[:cntrl:]]'
    ) NOT VALID;

ALTER TABLE public.subscriber_lifecycle
    VALIDATE CONSTRAINT subscriber_lifecycle_tenant_subscriber_fkey;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_tenant_subscriber_fkey;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_previous_stage_check;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_next_stage_check;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_actual_transition_check;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_source_check;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_reason_check;

COMMIT;
