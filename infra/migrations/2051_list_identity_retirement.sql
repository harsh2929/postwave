-- 2051_list_identity_retirement.sql
--
-- Deleting a list left its Postwave identity behind, and the identity is what
-- every list-scoped surface resolves through.
--
-- DELETE /api/v1/lists/{id} only proxied the delete to Listmonk. The
-- list_id_map row survived, so after the list was gone:
--   * GET /api/v1/lists/{deletedId}/subscribers still answered 200;
--   * a bulk add-to-list naming the deleted list's uuid succeeded, and its
--     memberships stayed attached to a list that no longer existed;
--   * campaign audience resolution, list analytics and list-scoped webhook
--     creation all kept resolving the deleted list.
--
-- WHY THE ROW IS RETIRED, NOT DELETED. outbound_webhooks carries a composite
-- FK to list_id_map (migration 1800) so a list-scoped endpoint can never name a
-- list its tenant does not own. A deleted endpoint is a tombstone that keeps
-- its list_id until the retention sweeper purges it with its delivery
-- evidence, so the identity row must outlive the list for as long as that
-- evidence does. Listmonk never reuses a list id, so a retired row cannot
-- collide with a future list.
--
-- WHY RETIREMENT IS ENFORCED BY RLS. A dozen statements in five packages
-- resolve a list through list_id_map (campaign audiences, audience sync,
-- webhook scoping, analytics, the members routes). A retired_at predicate
-- added to each would be complete only until the next resolver is written.
-- A restrictive SELECT policy makes a retired identity absent for the
-- application role everywhere at once: every resolver, present and future,
-- reports "list not found". Referential checks bypass RLS, so the webhook
-- tombstones keep their FK target.
--
-- It also closes the race with a concurrent writer. Each first-party
-- membership writer reads the mapping FOR KEY SHARE in the transaction that
-- writes the memberships; the deletion holds the mapping FOR UPDATE, then
-- sets retired_at. A writer that queued behind it re-checks the updated row
-- version against the policy and finds nothing.
--
-- WHY A SECURITY DEFINER. Under a policy that hides retired rows, an
-- application-role UPDATE that sets retired_at is rejected: PostgreSQL applies
-- SELECT policies to the new row of an UPDATE that reads the table, and the
-- new row is exactly the one the policy hides. retire_list_identity() performs
-- that one UPDATE, confined to the caller's own app.tenant_id, and nothing
-- else.
--
-- THE DENORMALISATION REPAIR. Memberships written by the bulk add-to-list verb
-- before this release carry a NULL listmonk_list_id and a NULL email: the verb
-- inserted only (tenant_id, list_id, subscriber_id, added_at). The subscriber
-- Lists panel names a list through listmonk_list_id, so those memberships
-- rendered with a blank name, and growth attribution joins on the same
-- column. Both values are recoverable exactly from list_id_map and
-- subscribers.
--
-- THE CROSS-TENANT REPAIR. The same verb took subscriber ids from the request
-- and inserted them without resolving them in the caller's tenant.
-- Referential checks bypass RLS, so a membership could name another tenant's
-- subscriber, and the list_joined trigger then queued that subscriber into
-- this tenant's flows. Those memberships and their owner rows are
-- soft-removed (the record survives, as for every removal), and the queued
-- flow runs that name a subscriber outside their own tenant are cancelled,
-- which is how an undone enrolment is recorded. Runs a worker already picked
-- up are left to finish, as the bulk undo does.
--
-- THE ACTIVE-MEMBERSHIP INDEX. Every list count (the Lists page, the Members
-- tab, campaign audiences) reads a list's rows with removed_at IS NULL. The
-- only per-list index also covers every removed row, and a count had to visit
-- the heap for removed_at. The partial index holds exactly the active rows
-- and carries subscriber_id, so the membership side of a count is an
-- index-only scan. It is built CONCURRENTLY after the transaction commits.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: The column, policy, function and index are additive. An
-- application rollback leaves retired identities invisible to the older
-- binary too, which is the correct behaviour for deleted lists. Do not drop
-- the policy while any row has retired_at set: that would resurrect every
-- deleted list's identity. The denormalisation repair only fills NULL columns
-- with values derived from their own source rows. The cross-tenant repair
-- removes memberships no tenant could see and cancels runs no tenant should
-- have queued; neither is reverted.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.list_id_map
    ADD COLUMN IF NOT EXISTS retired_at timestamptz;

COMMENT ON COLUMN public.list_id_map.retired_at IS
    'When the list was deleted. A retired identity is invisible to postwave_app (policy live_list_identities); the row survives only as the FK target of tombstoned list-scoped webhooks.';

DROP POLICY IF EXISTS live_list_identities ON public.list_id_map;
CREATE POLICY live_list_identities ON public.list_id_map
    AS RESTRICTIVE
    FOR SELECT
    TO postwave_app
    USING (retired_at IS NULL);

-- Retires one list identity of the session's tenant. Returns false when there
-- is no live identity with that uuid (already retired, another tenant's, or
-- never minted); the caller holds the row FOR UPDATE, so false means it was
-- not this caller's to retire.
--
-- pg_temp is LAST in search_path: without it the caller's temporary schema
-- is searched first and could shadow the objects referenced here.
CREATE OR REPLACE FUNCTION public.retire_list_identity(p_postwave_uuid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    session_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF session_tenant IS NULL THEN
        RAISE EXCEPTION 'retire_list_identity requires a tenant-scoped transaction'
            USING ERRCODE = '42501';
    END IF;
    UPDATE public.list_id_map
       SET retired_at = now()
     WHERE tenant_id = session_tenant
       AND postwave_uuid = p_postwave_uuid
       AND retired_at IS NULL;
    RETURN FOUND;
END
$function$;

COMMENT ON FUNCTION public.retire_list_identity(uuid) IS
    'Marks the session tenant''s list identity retired when its list is deleted. The only write path to list_id_map.retired_at.';

REVOKE ALL ON FUNCTION public.retire_list_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retire_list_identity(uuid) TO postwave_app;

-- Repair: denormalised engine id and address on memberships the bulk verb
-- wrote without them. Bounded to the NULL rows; both values are copied from
-- the rows they denormalise, never inferred.
UPDATE public.list_subscribers AS ls
   SET listmonk_list_id = m.listmonk_bigint_id
  FROM public.list_id_map AS m
 WHERE m.tenant_id = ls.tenant_id
   AND m.postwave_uuid = ls.list_id
   AND ls.listmonk_list_id IS NULL;

UPDATE public.list_subscribers AS ls
   SET email = s.email
  FROM public.subscribers AS s
 WHERE s.tenant_id = ls.tenant_id
   AND s.id = ls.subscriber_id
   AND ls.email IS NULL;

-- Repair: memberships, owner rows and queued flow runs that name a
-- subscriber outside their own tenant. Bounded to rows with no same-tenant
-- subscriber; a subscriber row is never touched.
UPDATE public.list_subscribers AS ls
   SET removed_at = now()
 WHERE ls.removed_at IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM public.subscribers AS s
          WHERE s.tenant_id = ls.tenant_id
            AND s.id = ls.subscriber_id);

UPDATE public.list_subscriber_sources AS lss
   SET removed_at = now()
 WHERE lss.removed_at IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM public.subscribers AS s
          WHERE s.tenant_id = lss.tenant_id
            AND s.id = lss.subscriber_id);

UPDATE public.flow_runs AS fr
   SET status = 'cancelled',
       error = 'Cancelled by migration 2051: the contact belongs to another workspace.'
 WHERE fr.status = 'queued'
   AND NOT EXISTS (
         SELECT 1
           FROM public.subscribers AS s
          WHERE s.tenant_id = fr.tenant_id
            AND s.id = fr.subscriber_id);

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS list_subscribers_active_list_idx
    ON public.list_subscribers (tenant_id, list_id, subscriber_id)
    WHERE removed_at IS NULL;
