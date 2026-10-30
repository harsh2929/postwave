-- 1667_marketing_worker_rls.sql
-- Allow bounded native marketing workers to enumerate due integrations across
-- tenants without weakening tenant-scoped app/API access. The index is built
-- concurrently because marketing_integrations is an existing tenant table.

DROP POLICY IF EXISTS marketing_integrations_worker_select ON marketing_integrations;
CREATE POLICY marketing_integrations_worker_select ON marketing_integrations
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.marketing_worker', true) = 'true');

CREATE INDEX CONCURRENTLY IF NOT EXISTS marketing_integrations_worker_backfill_idx
    ON marketing_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'active', 'error');
