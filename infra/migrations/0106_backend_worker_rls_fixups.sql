-- 0106_backend_worker_rls_fixups.sql
--
-- Runtime fixups for backend workers introduced around the SMS, migration,
-- deprovisioning, and seed-list rollout. Keep tenant RLS strict for request
-- paths while granting narrowly-scoped session-GUC visibility to workers that
-- must discover cross-tenant due work.

BEGIN;

-- Migration recovery worker: ClaimJob/RenewLease/ReleaseLease first need to
-- discover a row's tenant before re-scoping the transaction to that tenant.
DROP POLICY IF EXISTS migration_jobs_platform_worker_select ON migration_jobs;
CREATE POLICY migration_jobs_platform_worker_select ON migration_jobs
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.platform_admin', true) = 'true');

-- SMS queue worker: discovery queries join campaigns, recipients, sender
-- profiles, and throttle state with app.sms_worker set and no app.tenant_id.
DROP POLICY IF EXISTS sms_worker_sender_profiles ON sms_sender_profiles;
CREATE POLICY sms_worker_sender_profiles ON sms_sender_profiles
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.sms_worker', true) = 'true');

DROP POLICY IF EXISTS sms_worker_throttle_state ON sms_send_throttle_state;
CREATE POLICY sms_worker_throttle_state ON sms_send_throttle_state
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.sms_worker', true) = 'true');

-- Sending deprovision queue: tenant paths can schedule jobs; the delayed
-- cleanup worker can claim and mark due jobs without a tenant context.
ALTER TABLE sending_deprovision_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_deprovision_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sending_deprovision_jobs_tenant_visible ON sending_deprovision_jobs;
CREATE POLICY sending_deprovision_jobs_tenant_visible ON sending_deprovision_jobs
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS sending_deprovision_jobs_worker ON sending_deprovision_jobs;
DROP POLICY IF EXISTS sending_deprovision_jobs_worker_select ON sending_deprovision_jobs;
CREATE POLICY sending_deprovision_jobs_worker_select ON sending_deprovision_jobs
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.sending_deprovision_worker', true) = 'true');

DROP POLICY IF EXISTS sending_deprovision_jobs_worker_update ON sending_deprovision_jobs;
CREATE POLICY sending_deprovision_jobs_worker_update ON sending_deprovision_jobs
    AS PERMISSIVE
    FOR UPDATE
    TO postwave_app
    USING (current_setting('app.sending_deprovision_worker', true) = 'true')
    WITH CHECK (current_setting('app.sending_deprovision_worker', true) = 'true');

-- Seed-list outcomes are written by the deliverability service under tenant
-- scope. Bigserial inserts need sequence usage in addition to table grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON seedlist_outcomes TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE seedlist_outcomes_id_seq TO postwave_app;
ALTER TABLE seedlist_outcomes FORCE ROW LEVEL SECURITY;

COMMIT;
