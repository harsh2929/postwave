-- Scheduled native lead-capture workers enumerate due integrations across tenants,
-- then re-enter tenant scope for per-tenant sync writes.
DROP POLICY IF EXISTS lead_integrations_worker_select ON lead_integrations;
CREATE POLICY lead_integrations_worker_select ON lead_integrations
    FOR SELECT
    USING (current_setting('app.lead_worker', true) = 'true');

CREATE INDEX IF NOT EXISTS lead_integrations_worker_backfill_idx
    ON lead_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'error');
