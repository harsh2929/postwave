-- 1637_review_loyalty_worker_rls.sql
-- Allow bounded review/loyalty backfill workers to enumerate due integrations
-- across tenants without weakening tenant-scoped app/API access.

BEGIN;

DROP POLICY IF EXISTS review_integrations_worker_select ON review_integrations;
CREATE POLICY review_integrations_worker_select ON review_integrations
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.review_worker', true) = 'true');

CREATE INDEX IF NOT EXISTS review_integrations_worker_backfill_idx
    ON review_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'active', 'error');

DROP POLICY IF EXISTS loyalty_integrations_worker_select ON loyalty_integrations;
CREATE POLICY loyalty_integrations_worker_select ON loyalty_integrations
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.loyalty_worker', true) = 'true');

CREATE INDEX IF NOT EXISTS loyalty_integrations_worker_backfill_idx
    ON loyalty_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'active', 'error');

COMMIT;
