-- 1635_subscription_worker_rls.sql
-- Allow bounded subscription backfill workers to enumerate due integrations
-- across tenants without weakening tenant-scoped app/API access.

BEGIN;

DROP POLICY IF EXISTS subscription_integrations_worker_select ON subscription_integrations;
CREATE POLICY subscription_integrations_worker_select ON subscription_integrations
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.subscription_worker', true) = 'true');

COMMIT;
