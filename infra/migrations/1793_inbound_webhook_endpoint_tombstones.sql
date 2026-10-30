-- 1793_inbound_webhook_endpoint_tombstones.sql
-- rollback-strategy: expand-contract
-- rollback-details: retain deleted_at, the filtered public lookup, and the
-- guarded purge function if the application rolls back. Older binaries will
-- be unable to hard-delete endpoints because direct DELETE remains revoked;
-- restore the forward release to resume deferred cleanup.
--
-- A hard endpoint delete cascaded through inbound_events and durable action
-- intents. If a leased worker completed an external side effect just before
-- the cascade, its completion evidence vanished. Deletion is now a tombstone:
-- ingest is revoked immediately, normal admin reads hide the endpoint, event
-- retention proceeds normally, and a tenant-scoped retention pass purges the
-- endpoint only after no retained events remain.

ALTER TABLE inbound_webhook_endpoints
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz;

ALTER TABLE inbound_webhook_endpoints
    ALTER COLUMN updated_at SET DEFAULT now();

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_webhook_endpoints_deleted_idx
    ON inbound_webhook_endpoints (tenant_id, deleted_at, id)
    WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION inbound_webhook_lookup(p_slug text)
RETURNS TABLE (id uuid, tenant_id uuid, secret text, enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT endpoint.id, endpoint.tenant_id, endpoint.secret, endpoint.enabled
      FROM public.inbound_webhook_endpoints AS endpoint
     WHERE endpoint.slug = p_slug
       AND endpoint.deleted_at IS NULL;
$$;

REVOKE DELETE ON inbound_webhook_endpoints FROM postwave_app;

CREATE OR REPLACE FUNCTION purge_deleted_inbound_webhook_endpoint(
    p_tenant_id uuid,
    p_endpoint_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    removed boolean := false;
BEGIN
    IF p_tenant_id IS DISTINCT FROM
       NULLIF(current_setting('app.tenant_id', true), '')::uuid
    THEN
        RAISE EXCEPTION 'tenant scope mismatch';
    END IF;

    DELETE FROM public.inbound_webhook_endpoints AS endpoint
     WHERE endpoint.tenant_id = p_tenant_id
       AND endpoint.id = p_endpoint_id
       AND endpoint.deleted_at IS NOT NULL
       AND endpoint.deleted_at < now() - interval '24 hours'
       AND NOT EXISTS (
           SELECT 1
             FROM public.inbound_events AS event
            WHERE event.tenant_id = endpoint.tenant_id
              AND event.endpoint_id = endpoint.id
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.inbound_webhook_action_intents AS action
            WHERE action.tenant_id = endpoint.tenant_id
              AND action.endpoint_id = endpoint.id
       );
    removed := FOUND;
    RETURN removed;
END
$function$;

REVOKE ALL ON FUNCTION purge_deleted_inbound_webhook_endpoint(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_deleted_inbound_webhook_endpoint(uuid, uuid) TO postwave_app;

COMMENT ON COLUMN inbound_webhook_endpoints.deleted_at IS
    'Deletion tombstone; ingest/admin reads are revoked immediately and retention purges only after evidence expires.';
