-- 1770_automation_lifecycle_event_inbox.sql
--
-- Lifecycle transitions leave apps/api through the generic durable outbox, but
-- the automation service previously acknowledged them after a best-effort loop:
-- individual Engine.Trigger failures were logged and discarded, a replay could
-- enqueue a second run, and concurrent outbox workers could deliver transition
-- N+1 before N.  This migration installs the receiving half of that boundary.
--
-- No contact address or arbitrary event payload is retained here.  The inbox is
-- keyed by the gateway's opaque source event id and subscriber UUID, freezes the
-- exact set of intended automation dispatches, and advances one tenant-scoped
-- subscriber cursor only after every dispatch has reached a durable terminal
-- acceptance.  The runtime resolves the subscriber's current address at each
-- delivery attempt.
--
-- rollback-strategy: no-op
-- rollback-details: inbox receipts and dispatch outcomes are delivery evidence.
-- Older binaries ignore the additive lifecycle sequence column and new tables.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.subscriber_lifecycle
    ADD COLUMN IF NOT EXISTS transition_sequence bigint NOT NULL DEFAULT 0;

ALTER TABLE public.subscriber_lifecycle
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_transition_sequence_check;
ALTER TABLE public.subscriber_lifecycle
    ADD CONSTRAINT subscriber_lifecycle_transition_sequence_check
    CHECK (transition_sequence >= 0) NOT VALID;

ALTER TABLE public.subscriber_lifecycle_events
    ADD COLUMN IF NOT EXISTS transition_sequence bigint;

-- Existing audit rows predate the sequence contract. Their (at,id) order is
-- deterministic even when two transitions share a timestamp. The migration's
-- ALTER locks remain held until COMMIT, so no writer can interleave an
-- unsequenced event between this backfill and the NOT NULL contract.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY tenant_id, subscriber_id
               ORDER BY at, id
           )::bigint AS transition_sequence
      FROM public.subscriber_lifecycle_events
)
UPDATE public.subscriber_lifecycle_events AS event
   SET transition_sequence = ranked.transition_sequence
  FROM ranked
 WHERE event.id = ranked.id
   AND event.transition_sequence IS NULL;

-- transition_sequence is bookkeeping, not a user lifecycle edit. Suppress the
-- table's generic updated_at trigger for this one backfill so historical stage
-- chronology and parent aggregate revisions do not jump at deploy time.
ALTER TABLE public.subscriber_lifecycle
    DISABLE TRIGGER subscriber_lifecycle_set_updated_at;

UPDATE public.subscriber_lifecycle AS lifecycle
   SET transition_sequence = greatest(
       lifecycle.transition_sequence,
       history.last_sequence
   )
  FROM (
      SELECT tenant_id, subscriber_id, max(transition_sequence) AS last_sequence
        FROM public.subscriber_lifecycle_events
       GROUP BY tenant_id, subscriber_id
  ) AS history
 WHERE lifecycle.tenant_id = history.tenant_id
   AND lifecycle.subscriber_id = history.subscriber_id;

ALTER TABLE public.subscriber_lifecycle
    ENABLE TRIGGER subscriber_lifecycle_set_updated_at;

ALTER TABLE public.subscriber_lifecycle
    VALIDATE CONSTRAINT subscriber_lifecycle_transition_sequence_check;

-- Validate a NOT NULL-equivalent CHECK under the lighter validation lock so
-- SET NOT NULL can reuse the proof instead of rescanning the hot history table
-- while holding ACCESS EXCLUSIVE.
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_transition_sequence_not_null
    CHECK (transition_sequence IS NOT NULL) NOT VALID;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_transition_sequence_not_null;
ALTER TABLE public.subscriber_lifecycle_events
    ALTER COLUMN transition_sequence SET NOT NULL;
ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT subscriber_lifecycle_events_transition_sequence_not_null;

ALTER TABLE public.subscriber_lifecycle_events
    DROP CONSTRAINT IF EXISTS subscriber_lifecycle_events_transition_sequence_check;
ALTER TABLE public.subscriber_lifecycle_events
    ADD CONSTRAINT subscriber_lifecycle_events_transition_sequence_check
    CHECK (transition_sequence > 0) NOT VALID;
ALTER TABLE public.subscriber_lifecycle_events
    VALIDATE CONSTRAINT subscriber_lifecycle_events_transition_sequence_check;

CREATE UNIQUE INDEX IF NOT EXISTS subscriber_lifecycle_events_sequence_unique
    ON public.subscriber_lifecycle_events
        (tenant_id, subscriber_id, transition_sequence);

-- Rolling-deploy compatibility for a pre-1770 API instance. Older writers do
-- not name transition_sequence in their history INSERT. Allocate it under the
-- same sidecar-row lock in that case, while requiring an explicit sequence from
-- a new writer to agree with the sidecar high-water mark. This makes the new
-- NOT NULL column compatible in both deployment directions and prevents a
-- bypass writer from creating a gap or duplicate.
CREATE OR REPLACE FUNCTION public.subscriber_lifecycle_event_assign_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    current_sequence bigint;
BEGIN
    SELECT lifecycle.transition_sequence
      INTO current_sequence
      FROM public.subscriber_lifecycle AS lifecycle
     WHERE lifecycle.tenant_id = NEW.tenant_id
       AND lifecycle.subscriber_id = NEW.subscriber_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'lifecycle sidecar missing for subscriber history event'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.transition_sequence IS NULL THEN
        current_sequence := current_sequence + 1;
        UPDATE public.subscriber_lifecycle AS lifecycle
           SET transition_sequence = current_sequence
         WHERE lifecycle.tenant_id = NEW.tenant_id
           AND lifecycle.subscriber_id = NEW.subscriber_id;
        NEW.transition_sequence := current_sequence;
    ELSIF NEW.transition_sequence <> current_sequence THEN
        RAISE EXCEPTION 'lifecycle transition sequence % does not match sidecar sequence %',
            NEW.transition_sequence, current_sequence
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_lifecycle_event_assign_sequence()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_lifecycle_event_assign_sequence()
    TO postwave_app;

DROP TRIGGER IF EXISTS subscriber_lifecycle_event_assign_sequence
    ON public.subscriber_lifecycle_events;
CREATE TRIGGER subscriber_lifecycle_event_assign_sequence
    BEFORE INSERT ON public.subscriber_lifecycle_events
    FOR EACH ROW
    EXECUTE FUNCTION public.subscriber_lifecycle_event_assign_sequence();

COMMENT ON COLUMN public.subscriber_lifecycle.transition_sequence IS
    'Monotonic aggregate sequence allocated in the lifecycle mutation transaction; automation delivery accepts transitions only in this order.';

CREATE TABLE IF NOT EXISTS public.automation_lifecycle_event_inbox (
    tenant_id             uuid        NOT NULL
        REFERENCES public.tenants(id) ON DELETE CASCADE,
    source_event_id       text        NOT NULL,
    -- subscriber_key is immutable delivery evidence. subscriber_id is the
    -- live composite-FK reference and becomes NULL during erasure.
    subscriber_key        uuid        NOT NULL,
    subscriber_id         uuid,
    transition_sequence   bigint      NOT NULL,
    event_type            text        NOT NULL,
    previous_stage        text        NOT NULL DEFAULT '',
    next_stage            text        NOT NULL,
    score                 smallint    NOT NULL,
    transitioned_at       timestamptz NOT NULL,
    semantic_fingerprint  text        NOT NULL,
    target_set_frozen     boolean     NOT NULL DEFAULT false,
    intended_count        integer     NOT NULL DEFAULT 0,
    state                 text        NOT NULL DEFAULT 'received',
    accepted_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, source_event_id),
    UNIQUE (tenant_id, subscriber_key, transition_sequence),
    CONSTRAINT automation_lifecycle_inbox_subscriber_fkey
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES public.subscribers (tenant_id, id)
        ON DELETE SET NULL (subscriber_id),
    CHECK (source_event_id = btrim(source_event_id)),
    CHECK (source_event_id ~ '^[!-~]{1,200}$'),
    CHECK (transition_sequence > 0),
    CHECK (subscriber_id IS NULL OR subscriber_id = subscriber_key),
    CHECK (event_type = 'subscriber_lifecycle_stage_changed'),
    CHECK (previous_stage IN (
        '', 'subscriber', 'lead', 'mql', 'sql', 'opportunity',
        'customer', 'evangelist', 'other'
    )),
    CHECK (next_stage IN (
        'subscriber', 'lead', 'mql', 'sql', 'opportunity',
        'customer', 'evangelist', 'other'
    )),
    CHECK (previous_stage <> next_stage),
    CHECK (score BETWEEN 1 AND 5),
    CHECK (semantic_fingerprint ~ '^[0-9a-f]{64}$'),
    CHECK (intended_count >= 0),
    CHECK (state IN ('received', 'accepted', 'subscriber_erased')),
    CHECK (
        (state = 'received' AND accepted_at IS NULL) OR
        (state IN ('accepted', 'subscriber_erased') AND
         target_set_frozen AND accepted_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.automation_lifecycle_event_inbox IS
    'PII-minimised, tenant-scoped durable receipts for ordered lifecycle-to-automation delivery.';
COMMENT ON COLUMN public.automation_lifecycle_event_inbox.semantic_fingerprint IS
    'SHA-256 over immutable transition semantics, excluding the mutable/current subscriber address.';

CREATE TABLE IF NOT EXISTS public.automation_lifecycle_event_dispatches (
    tenant_id          uuid        NOT NULL,
    source_event_id    text        NOT NULL,
    automation_id      uuid        NOT NULL,
    trigger_type       text        NOT NULL,
    state              text        NOT NULL DEFAULT 'pending',
    result             text,
    attempt_count      integer     NOT NULL DEFAULT 0,
    last_error_code    text,
    accepted_at        timestamptz,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, source_event_id, automation_id),
    CONSTRAINT automation_lifecycle_dispatch_inbox_fkey
        FOREIGN KEY (tenant_id, source_event_id)
        REFERENCES public.automation_lifecycle_event_inbox
            (tenant_id, source_event_id)
        ON DELETE CASCADE,
    CHECK (trigger_type = 'subscriber_lifecycle_stage_changed'),
    CHECK (state IN ('pending', 'accepted')),
    CHECK (result IS NULL OR result IN ('queued', 'policy_skipped', 'subscriber_erased')),
    CHECK (attempt_count >= 0),
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.:-]{1,64}$'),
    CHECK (
        (state = 'pending' AND result IS NULL AND accepted_at IS NULL) OR
        (state = 'accepted' AND result IS NOT NULL AND accepted_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.automation_lifecycle_event_dispatches IS
    'One durable acceptance outcome per automation frozen for a lifecycle inbox receipt; contains no subscriber address or payload PII.';

CREATE TABLE IF NOT EXISTS public.automation_lifecycle_subscriber_cursors (
    tenant_id             uuid        NOT NULL
        REFERENCES public.tenants(id) ON DELETE CASCADE,
    subscriber_id         uuid        NOT NULL,
    last_accepted_sequence bigint     NOT NULL DEFAULT 0,
    last_source_event_id   text,
    updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, subscriber_id),
    CONSTRAINT automation_lifecycle_cursor_subscriber_fkey
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES public.subscribers (tenant_id, id)
        ON DELETE CASCADE,
    CHECK (last_accepted_sequence >= 0),
    CHECK (
        (last_accepted_sequence = 0 AND last_source_event_id IS NULL) OR
        (last_accepted_sequence > 0 AND last_source_event_id IS NOT NULL)
    )
);

-- Historical transitions were handled by the pre-inbox best-effort path and
-- cannot be replayed with stable source ids. Seed their aggregate high-water
-- mark so the first post-1770 event (N+1) is not permanently mistaken for a
-- gap. The marker contains no contact data and is not an inbox receipt.
INSERT INTO public.automation_lifecycle_subscriber_cursors
    (tenant_id, subscriber_id, last_accepted_sequence, last_source_event_id)
SELECT tenant_id, subscriber_id, transition_sequence, 'migration-baseline:1770'
  FROM public.subscriber_lifecycle
 WHERE transition_sequence > 0
ON CONFLICT (tenant_id, subscriber_id) DO NOTHING;

COMMENT ON TABLE public.automation_lifecycle_subscriber_cursors IS
    'Last fully accepted lifecycle transition per tenant subscriber; gaps remain retryable and cannot overtake earlier transitions.';

CREATE INDEX IF NOT EXISTS automation_lifecycle_inbox_pending_idx
    ON public.automation_lifecycle_event_inbox
        (tenant_id, subscriber_key, transition_sequence)
    WHERE state = 'received';

CREATE INDEX IF NOT EXISTS automation_lifecycle_dispatch_pending_idx
    ON public.automation_lifecycle_event_dispatches
        (tenant_id, source_event_id, automation_id)
    WHERE state = 'pending';

-- Subscriber erasure must not be blocked by delivery evidence and must not
-- cascade that evidence away. Before the live row disappears, terminalize any
-- pending outcomes and null only the composite-FK column. subscriber_key,
-- source_event_id, sequence, and semantic fingerprint remain as a PII-free
-- tombstone; the operational cursor is removed by its ON DELETE CASCADE FK.
CREATE OR REPLACE FUNCTION public.automation_lifecycle_terminalize_on_subscriber_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    UPDATE public.automation_lifecycle_event_dispatches AS dispatch
       SET state = 'accepted',
           result = 'subscriber_erased',
           attempt_count = attempt_count + 1,
           last_error_code = NULL,
           accepted_at = COALESCE(dispatch.accepted_at, clock_timestamp()),
           updated_at = clock_timestamp()
      FROM public.automation_lifecycle_event_inbox AS inbox
     WHERE inbox.tenant_id = OLD.tenant_id
       AND inbox.subscriber_key = OLD.id
       AND dispatch.tenant_id = inbox.tenant_id
       AND dispatch.source_event_id = inbox.source_event_id
       AND dispatch.state = 'pending';

    UPDATE public.automation_lifecycle_event_inbox AS inbox
       SET subscriber_id = NULL,
           target_set_frozen = true,
           intended_count = (
               SELECT count(*)::integer
                 FROM public.automation_lifecycle_event_dispatches AS dispatch
                WHERE dispatch.tenant_id = inbox.tenant_id
                  AND dispatch.source_event_id = inbox.source_event_id
           ),
           state = 'subscriber_erased',
           accepted_at = COALESCE(accepted_at, clock_timestamp()),
           updated_at = clock_timestamp()
     WHERE inbox.tenant_id = OLD.tenant_id
       AND inbox.subscriber_key = OLD.id
       AND inbox.state = 'received';

    RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.automation_lifecycle_terminalize_on_subscriber_delete()
    FROM PUBLIC;

DROP TRIGGER IF EXISTS subscribers_automation_lifecycle_terminalize
    ON public.subscribers;
CREATE TRIGGER subscribers_automation_lifecycle_terminalize
    BEFORE DELETE ON public.subscribers
    FOR EACH ROW
    EXECUTE FUNCTION public.automation_lifecycle_terminalize_on_subscriber_delete();

REVOKE ALL ON TABLE public.automation_lifecycle_event_inbox FROM PUBLIC;
REVOKE ALL ON TABLE public.automation_lifecycle_event_dispatches FROM PUBLIC;
REVOKE ALL ON TABLE public.automation_lifecycle_subscriber_cursors FROM PUBLIC;

GRANT SELECT ON TABLE public.automation_lifecycle_event_inbox TO postwave_app;
GRANT INSERT (
    tenant_id, source_event_id, subscriber_key, subscriber_id,
    transition_sequence, event_type, previous_stage, next_stage, score,
    transitioned_at, semantic_fingerprint
) ON public.automation_lifecycle_event_inbox TO postwave_app;
GRANT UPDATE (
    target_set_frozen, intended_count, state, accepted_at, updated_at
) ON public.automation_lifecycle_event_inbox TO postwave_app;

GRANT SELECT ON TABLE public.automation_lifecycle_event_dispatches TO postwave_app;
GRANT INSERT (
    tenant_id, source_event_id, automation_id, trigger_type
) ON public.automation_lifecycle_event_dispatches TO postwave_app;
GRANT UPDATE (
    state, result, attempt_count, last_error_code, accepted_at, updated_at
) ON public.automation_lifecycle_event_dispatches TO postwave_app;

GRANT SELECT ON TABLE public.automation_lifecycle_subscriber_cursors TO postwave_app;
GRANT INSERT (
    tenant_id, subscriber_id
) ON public.automation_lifecycle_subscriber_cursors TO postwave_app;
GRANT UPDATE (
    last_accepted_sequence, last_source_event_id, updated_at
) ON public.automation_lifecycle_subscriber_cursors TO postwave_app;

ALTER TABLE public.automation_lifecycle_event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_lifecycle_event_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.automation_lifecycle_event_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_lifecycle_event_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.automation_lifecycle_subscriber_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_lifecycle_subscriber_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY automation_lifecycle_inbox_tenant_isolation
    ON public.automation_lifecycle_event_inbox
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY automation_lifecycle_inbox_tenant_visible
    ON public.automation_lifecycle_event_inbox
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY automation_lifecycle_dispatch_tenant_isolation
    ON public.automation_lifecycle_event_dispatches
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY automation_lifecycle_dispatch_tenant_visible
    ON public.automation_lifecycle_event_dispatches
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY automation_lifecycle_cursor_tenant_isolation
    ON public.automation_lifecycle_subscriber_cursors
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY automation_lifecycle_cursor_tenant_visible
    ON public.automation_lifecycle_subscriber_cursors
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
