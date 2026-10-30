-- Scheduled native CRM workers enumerate due integrations across tenants,
-- then re-enter tenant scope for per-tenant sync writes.
DROP POLICY IF EXISTS crm_integrations_worker_select ON crm_integrations;
CREATE POLICY crm_integrations_worker_select ON crm_integrations
    FOR SELECT
    USING (current_setting('app.crm_worker', true) = 'true');

CREATE INDEX IF NOT EXISTS crm_integrations_worker_backfill_idx
    ON crm_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'error');
