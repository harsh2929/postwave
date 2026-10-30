-- 1116_custom_domains_public_host_lookup.sql
--
-- SUB-122: first-party server-side event endpoint.
--
-- POST /api/public/track/event is a public, no-auth ingestion surface
-- that storefronts/apps call server-side OR via a first-party CNAME so
-- subscriber activity can be recorded without third-party cookies.
--
-- When the caller reaches the endpoint over a first-party CNAME, the
-- handler must map the request Host -> tenant BEFORE it has any tenant
-- context (it doesn't know the tenant yet). custom_domains already maps
-- domain -> tenant, but its tenant gate is RESTRICTIVE (0070) and the
-- request-path PERMISSIVE policy is tenant_visible (0079) — both keyed
-- on app.tenant_id, so a public lookup that doesn't yet know the tenant
-- can read nothing.
--
-- Postgres RLS combines policies as: a row is visible iff (>=1 PERMISSIVE
-- USING passes) AND (every RESTRICTIVE USING passes). So enabling the
-- public host lookup requires BOTH:
--   (1) a PERMISSIVE SELECT policy gated on a request-scoped GUC
--       (app.public_track_host), mirroring conversion_tracking_keys_public_lookup
--       (0049, app.conversion_track_hash); AND
--   (2) widening the RESTRICTIVE tenant_isolation gate's READ side so the
--       permissive policy can actually fire under host scope — the exact
--       pattern referral_conversions used in 0383 to admit worker-scope reads.
-- WITH CHECK on the restrictive gate stays tenant-only, so the host GUC can
-- grant a READ but never an INSERT/UPDATE/DELETE.
--
-- The handler binds app.public_track_host to the lowercased request Host
-- for the duration of one tx, reads the single matching VERIFIED row, and
-- proceeds. Only verified domains resolve, so an unverified / spoofed Host
-- cannot be used to attribute events to a tenant. Comparison is citext so
-- host casing never causes a miss.
--
-- No new table is required: subscriber_events (0013 + 0165 dedup columns +
-- 0324 'custom' event_type) already serves the event store, and its
-- (tenant_id, source, source_event_id) partial-unique index already
-- provides ON CONFLICT DO NOTHING idempotency for client-supplied dedup
-- keys (reused via subscribers.Repo.RecordSubscriberEvent).

BEGIN;

-- (1) Permissive SELECT policy for the first-party event handler, which
-- resolves the tenant from the request Host WITHOUT a tenant context.
-- The GUC defaults to '' when unset, and a domain is never '', so an
-- unbound GUC matches nothing. Only verified domains are eligible.
DROP POLICY IF EXISTS custom_domains_public_host_lookup ON custom_domains;
CREATE POLICY custom_domains_public_host_lookup ON custom_domains
    AS PERMISSIVE
    FOR SELECT
    USING (
      domain = NULLIF(current_setting('app.public_track_host', true), '')::citext
      AND verified IS TRUE
    );

-- (2) Widen the RESTRICTIVE tenant gate's read side so the permissive
-- policy above can fire under host scope (restrictive policies AND). The
-- write side (WITH CHECK) deliberately stays tenant-only: the public host
-- GUC can never be used to insert or mutate a custom_domains row.
DROP POLICY IF EXISTS tenant_isolation ON custom_domains;
CREATE POLICY tenant_isolation ON custom_domains
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            domain = NULLIF(current_setting('app.public_track_host', true), '')::citext
            AND verified IS TRUE
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
