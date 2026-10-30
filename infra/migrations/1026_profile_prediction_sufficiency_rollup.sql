-- 1026_profile_prediction_sufficiency_rollup.sql
--
-- SUB-129: data-sufficiency tenant report — a tenant-wide rollup of which
-- predictions are reliable per profile bucket.
--
-- profile_predictions.data_sufficiency (migration 0206) already classifies
-- every scored profile as insufficient / limited / sufficient, but every
-- consumer that wanted the tenant-wide distribution had to re-run a three-way
-- GROUP BY count over the full profile_predictions table. This table caches
-- that distribution as one row per tenant so a report/dashboard read is a
-- single-row primary-key lookup instead of an aggregate scan.
--
-- The rollup is refreshed on-demand inside the predictive recompute handler
-- (apps/api/internal/predictive/repo.go: Recompute, after upsertPredictions)
-- via INSERT ... ON CONFLICT (tenant_id) DO UPDATE, so it always reflects the
-- snapshot produced by the most recent recompute. The percentages are derived
-- on read (counts / total) so we never store a value that can drift out of
-- sync with its own counts.
--
-- One row per tenant (PRIMARY KEY on tenant_id). RLS shape copied from
-- infra/migrations/0321_subscriber_view_prefs.sql — RESTRICTIVE
-- tenant_isolation + PERMISSIVE tenant_visible, both reading the tenant GUC
-- via NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset
-- GUC degrades to "no rows" rather than crashing on a raw ::uuid cast.

BEGIN;

CREATE TABLE IF NOT EXISTS profile_prediction_sufficiency_rollup (
    tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    insufficient_count integer NOT NULL DEFAULT 0 CHECK (insufficient_count >= 0),
    limited_count      integer NOT NULL DEFAULT 0 CHECK (limited_count >= 0),
    sufficient_count   integer NOT NULL DEFAULT 0 CHECK (sufficient_count >= 0),
    total_count        integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
    last_updated       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON profile_prediction_sufficiency_rollup TO postwave_app;

ALTER TABLE profile_prediction_sufficiency_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_prediction_sufficiency_rollup FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON profile_prediction_sufficiency_rollup;
CREATE POLICY tenant_isolation ON profile_prediction_sufficiency_rollup
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON profile_prediction_sufficiency_rollup;
CREATE POLICY tenant_visible ON profile_prediction_sufficiency_rollup
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
