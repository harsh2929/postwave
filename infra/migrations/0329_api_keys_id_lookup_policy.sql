-- 0329_api_keys_id_lookup_policy.sql
--
-- Add a tenant-less SELECT policy on api_keys keyed on app.api_key_id.
--
-- Background: the per-API-key rate-limit middleware
-- (middleware.KeyRateLimit) needs to read RateLimitPerMin/PerDay/Burst
-- for an authenticated key id during the request hot path, BEFORE the
-- tenant middleware has had a chance to bind app.tenant_id for the
-- downstream tenant-scoped queries. The previous wiring called
-- apikeys.Repo.Get(ctx, "" /* tenant unused */, keyID) which went
-- through db.WithTenant — that helper rejects empty tenant ids,
-- which meant the lookup ALWAYS errored, the lookup function ALWAYS
-- returned (0,0,0), and per-key rate limits were silently never
-- enforced.
--
-- This migration adds a SELECT-only policy mirroring the existing
-- api_keys_hash_lookup pattern from 0018, but keyed on app.api_key_id
-- (which is already bound by TouchLastUsed and by the new
-- Repo.LookupByID code path). RLS still ensures the SELECT only
-- exposes the exact row matching the bound id — no cross-tenant
-- leakage.
--
-- Note: the existing UPDATE policy api_keys_last_used_public_update
-- from 0018 ALSO uses app.api_key_id but only for UPDATE. The new
-- policy is FOR SELECT only and stacks (OR-style) with the existing
-- tenant_isolation policy, so per-tenant reads continue to work
-- unchanged.

BEGIN;

CREATE POLICY api_keys_id_lookup ON api_keys
    FOR SELECT
    USING (
        revoked_at IS NULL
        AND id = NULLIF(current_setting('app.api_key_id', true), '')::uuid
    );

COMMIT;
