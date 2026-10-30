-- 1707_list_joined_flow_trigger.sql
--
-- `list_joined` is advertised by the flow-builder catalog as
-- RuntimeStatus:"supported" and is the trigger behind the single most common
-- automation there is — the welcome series. It had ZERO producers anywhere in
-- the codebase: `grep -rn '"list_joined"'` matched only the catalog entry
-- itself. Nothing ever fired it. "Send a welcome email when someone joins this
-- list" silently did nothing.
--
-- WHY A DATABASE TRIGGER
-- ---------------------
-- Six different Go call sites INSERT into list_subscribers (bulk import, the
-- membership API, archive restore, listmonk event sync, membership sources,
-- bulk ops). Wiring a producer into each one is exactly the kind of change that
-- misses the seventh. The table is the real chokepoint: every path, present and
-- future, goes through it.
--
-- The flow_runs rows this writes are drained by the flowbuilder.Drainer
-- (apps/api), which resolves the subscriber and fires the automation service.
--
-- The trigger_payload carries the list id because Engine.Trigger re-checks it:
-- a flow whose trigger specifies list_id only fires for that list.

CREATE OR REPLACE FUNCTION enqueue_list_joined_flow_runs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Fan out to every ACTIVE flow in this tenant whose trigger spec matches.
    -- A trigger with no list_id means "any list".
    --
    -- LIMIT 10 mirrors the hard cap the tag-trigger adapter already applies
    -- (MaxTagTriggerFanout): a tenant that wires the same list into 500 flows
    -- must not turn one list-join into 500 queued runs.
    INSERT INTO flow_runs (tenant_id, flow_id, subscriber_id, trigger_event_name, trigger_payload)
    SELECT NEW.tenant_id,
           j.id,
           NEW.subscriber_id,
           'list_joined',
           jsonb_build_object('list_id', NEW.list_id::text)
      FROM automation_journeys j
     WHERE j.tenant_id = NEW.tenant_id
       AND j.status = 'active'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(j.triggers, '[]'::jsonb)) AS t
              WHERE t->>'type' = 'list_joined'
                AND (
                      COALESCE(NULLIF(t->>'list_id', ''), '') = ''
                   OR t->>'list_id' = NEW.list_id::text
                )
           )
     LIMIT 10;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enqueue_list_joined_flow_runs() IS
    'Enqueues flow_runs for active flows with a matching list_joined trigger. The producer that list_joined never had.';

DROP TRIGGER IF EXISTS list_subscribers_enqueue_flow_runs ON list_subscribers;

-- AFTER INSERT: the membership must be durable before we promise a flow about
-- it. ON CONFLICT DO NOTHING re-inserts do not fire an AFTER INSERT trigger, so
-- re-adding an existing member does not re-fire the welcome series.
CREATE TRIGGER list_subscribers_enqueue_flow_runs
    AFTER INSERT ON list_subscribers
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_list_joined_flow_runs();
