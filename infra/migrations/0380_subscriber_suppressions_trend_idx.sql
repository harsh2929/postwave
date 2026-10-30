-- 0380_subscriber_suppressions_trend_idx.sql
--
-- Desktop audit A5: GET /api/v1/suppressions/trend aggregates
-- subscriber_suppressions by day-of-created_at within a tenant
-- (date_trunc group-by over a bounded window, default 30 days). The
-- table only has (tenant_id, email) and a partial (tenant_id,
-- expires_at) index from 0081, so the trend query would walk every
-- tenant row via the email index. A (tenant_id, created_at DESC)
-- btree turns the window scan into a tight range read and also serves
-- the converged list endpoint's ORDER BY created_at DESC pagination.

BEGIN;

CREATE INDEX IF NOT EXISTS subscriber_suppressions_tenant_created_idx
    ON subscriber_suppressions (tenant_id, created_at DESC);

COMMIT;
