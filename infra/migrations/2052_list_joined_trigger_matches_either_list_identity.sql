-- 2052_list_joined_trigger_matches_either_list_identity.sql
--
-- A flow whose "Joined list" trigger names a specific list never enrolled
-- anyone. Only "any list" triggers fired.
--
-- A list has two identities: the engine bigint every list picker holds, and
-- the Postwave uuid list_subscribers is keyed on (list_id_map pairs them).
-- The flow editor stores the trigger's list_id from its picker, so it stores
-- the engine id ("10"). enqueue_list_joined_flow_runs() (migration 1707)
-- compared that value with NEW.list_id::text — the uuid — and the automation
-- runtime compared it again with the payload's uuid. An engine id can never
-- equal a uuid, so the trigger was inert for every flow built in the editor,
-- while flows written by the migration service (which stores the uuid) worked.
--
-- WHY THE TRIGGER, NOT THE SAVED FLOW. Several writers store trigger list
-- ids — the flow builder, the compat journeys API, the automation service's
-- trigger API, the migration importer — in whichever form they hold. Rewriting
-- them to uuids at save time would have to cover each, and the web editor
-- would then show a list it can no longer find in its engine-keyed picker.
-- Matching both identities here, where every membership insert already
-- passes, covers every writer present and future, as 1707 intended.
--
-- THE PAYLOAD. list_id stays the canonical uuid: the bulk add-to-list undo
-- cancels enrolments by comparing trigger_payload->>'list_id' with it.
-- listmonk_list_id is added so the runtime's matcher can accept a trigger
-- stored in either form (services/automation canonical.MatchListJoined).
--
-- Trigger list ids are compared trimmed; a uuid is compared case-insensitively
-- because NEW.list_id::text is always lower-case. An identity retired by a
-- list deletion (migration 2051) no longer offers its engine id; nothing can
-- join such a list anyway. A journey whose triggers column is not a JSON
-- array is skipped instead of raising: 1707 called jsonb_array_elements on it
-- unguarded, so one malformed journey would have failed every membership
-- insert in its tenant.
--
-- CREATE OR REPLACE resets settings that are not restated, so SECURITY
-- DEFINER and the pg_temp-last search_path (migration 1915) are restated
-- here; ownership and the trigger binding are unchanged.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: The function body is replaced in place. The previous
-- body is strictly narrower (uuid-only matching); an application rollback
-- keeps working with this one, whose payload only adds a key.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.enqueue_list_joined_flow_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    joined_list_uuid text := NEW.list_id::text;
    joined_engine_id text;
BEGIN
    SELECT m.listmonk_bigint_id::text
      INTO joined_engine_id
      FROM public.list_id_map AS m
     WHERE m.tenant_id = NEW.tenant_id
       AND m.postwave_uuid = NEW.list_id
       AND m.retired_at IS NULL;

    -- Fan out to every ACTIVE flow in this tenant whose trigger spec matches.
    -- A trigger with no list_id means "any list".
    --
    -- LIMIT 10 mirrors the hard cap the tag-trigger adapter applies
    -- (MaxTagTriggerFanout): a tenant that wires the same list into 500 flows
    -- must not turn one list-join into 500 queued runs.
    INSERT INTO public.flow_runs (tenant_id, flow_id, subscriber_id, trigger_event_name, trigger_payload)
    SELECT NEW.tenant_id,
           j.id,
           NEW.subscriber_id,
           'list_joined',
           jsonb_strip_nulls(jsonb_build_object(
               'list_id', joined_list_uuid,
               'listmonk_list_id', joined_engine_id
           ))
      FROM public.automation_journeys AS j
     WHERE j.tenant_id = NEW.tenant_id
       AND j.status = 'active'
       AND jsonb_typeof(j.triggers) = 'array'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(j.triggers) AS t
              WHERE t->>'type' = 'list_joined'
                AND (
                      COALESCE(btrim(t->>'list_id'), '') = ''
                   OR lower(btrim(t->>'list_id')) = joined_list_uuid
                   OR btrim(t->>'list_id') = joined_engine_id
                )
           )
     LIMIT 10;

    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enqueue_list_joined_flow_runs() IS
    'Enqueues flow_runs for active flows whose list_joined trigger names the joined list by its Postwave uuid or its engine id (or names no list).';

COMMIT;
