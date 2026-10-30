-- Scheduled native commerce workers need to enumerate due integrations
-- across tenants, then re-enter tenant scope for sync writes.
DROP POLICY IF EXISTS commerce_integrations_worker_select ON commerce_integrations;
CREATE POLICY commerce_integrations_worker_select ON commerce_integrations
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE INDEX IF NOT EXISTS commerce_integrations_worker_backfill_idx
    ON commerce_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'error');
