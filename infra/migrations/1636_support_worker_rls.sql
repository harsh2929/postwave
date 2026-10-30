-- 1636_support_worker_rls.sql
-- Allow bounded support backfill workers to enumerate due helpdesk
-- integrations across tenants without weakening tenant-scoped app/API access.

BEGIN;

DROP POLICY IF EXISTS support_integrations_worker_select ON support_integrations;
CREATE POLICY support_integrations_worker_select ON support_integrations
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.support_worker', true) = 'true');

CREATE INDEX IF NOT EXISTS support_integrations_worker_backfill_idx
    ON support_integrations (provider, status, last_sync_at NULLS FIRST, updated_at)
    WHERE status IN ('connected', 'active', 'error');

COMMIT;
