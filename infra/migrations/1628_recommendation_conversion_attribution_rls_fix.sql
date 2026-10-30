-- 1628_recommendation_conversion_attribution_rls_fix.sql
--
-- Fixes the recommendation-conversion attribution loop shipped in commit
-- 1b4d6f53 (RecordConversionByClickID). That code resolves a click → its
-- tenant/recommendation and records a conversion under db.WithWorkerScope,
-- which sets app.outbox_worker='true' but deliberately leaves app.tenant_id
-- UNSET (the public conversion pixel has no tenant session — the unguessable
-- click-id uuid is the credential).
--
-- Two RLS gaps made the feature a silent no-op in production (it recorded
-- ZERO conversions while logging only a benign-looking "not found"):
--
--   1. recommendation_clicks (0286) has NO worker-scope escape, so the
--      worker-scoped SELECT that resolves the click matched zero rows →
--      every conversion returned ErrNotFound.
--   2. recommendation_conversions (0342) gave its PERMISSIVE policy a worker
--      escape but NOT its RESTRICTIVE tenant_isolation policy. RESTRICTIVE
--      policies are ANDed, so even after fix #1 the INSERT (and the
--      idempotency sub-SELECT) would still be blocked under worker scope.
--
-- We add the project-standard `OR current_setting('app.outbox_worker', true)
-- = 'true'` escape to exactly the clauses the worker path needs:
--   * clicks: USING only (the worker reads clicks; it never inserts them —
--     PublicRecommendationClick writes them tenant-scoped, so WITH CHECK
--     stays tenant-only and the insert path is not loosened).
--   * conversions tenant_isolation: USING (idempotency sub-SELECT) AND
--     WITH CHECK (the INSERT). The PERMISSIVE policy already has the escape.
--
-- Finally, the dedup was `INSERT … WHERE NOT EXISTS (… click_id …)` against a
-- NON-unique index, which is not race-safe (two concurrent re-fired pixels can
-- both pass the NOT EXISTS and double-count). We promote click_id to a partial
-- UNIQUE index so the application can switch to an atomic ON CONFLICT DO
-- NOTHING. The table is empty in production (the feature never recorded
-- anything), so the unique build cannot fail on existing duplicates.

BEGIN;

-- 1. recommendation_clicks: let the worker resolve a click cross-tenant.
ALTER POLICY tenant_isolation ON recommendation_clicks
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

ALTER POLICY tenant_visible ON recommendation_clicks
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

-- 2. recommendation_conversions: let the worker read (dedup sub-SELECT) and
--    write (the INSERT) under the RESTRICTIVE policy.
ALTER POLICY tenant_isolation ON recommendation_conversions
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

-- 3. Atomic, race-safe dedup: a partial UNIQUE index on click_id replaces the
--    plain lookup index so the app can ON CONFLICT DO NOTHING. NULL click_ids
--    (direct conversions not attributed to a click) remain unconstrained.
DROP INDEX IF EXISTS recommendation_conversions_click_idx;

CREATE UNIQUE INDEX IF NOT EXISTS recommendation_conversions_click_uq
    ON recommendation_conversions (click_id)
    WHERE click_id IS NOT NULL;

COMMIT;
