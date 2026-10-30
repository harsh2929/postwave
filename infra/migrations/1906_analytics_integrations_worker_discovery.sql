-- 1906_analytics_integrations_worker_discovery.sql
--
-- The analytics sync worker never found a single integration to sync.
--
-- `DueForSync` opens a transaction with NO tenant GUC — it is a cross-tenant
-- sweep, which is the point — sets `app.analytics_worker`, and selects every
-- integration whose cadence is due.
--
-- Nothing read that GUC. `analytics_integrations` carries FORCE ROW LEVEL
-- SECURITY and exactly four policies: three ingest-token lookups keyed on
-- `app.analytics_ingest_token`, and `tenant_isolation` keyed on
-- `app.tenant_id`. The sweep presents neither, so `tenant_id = NULL`, the query
-- matches nothing, and the worker returns an empty batch.
--
-- Proven directly: with the owning tenant set the integration is visible; with
-- the worker's own scope it is not.
--
-- THE FAILURE IS SILENT AND LOOKS HEALTHY. There is no error and no partial
-- result — a sweep that returns zero rows is exactly what an idle worker with
-- nothing to do looks like. Segment, RudderStack and every other configured
-- analytics destination simply never sync, and the only symptom is data that
-- does not arrive.
--
-- This is the fifth instance of one shape in this schema (see 1887, 1888, 1890,
-- 1895): a cross-tenant worker runs under a capability GUC that no policy
-- names, so its discovery query silently returns nothing.
--
-- SELECT ONLY. The sweep returns `tenant_id` with each row and every follow-up
-- write goes through `db.WithTenant`, so the worker needs to DISCOVER
-- cross-tenant and never to WRITE cross-tenant. Granting more would let a bug
-- in one tenant's sync path modify another's configuration.

BEGIN;

DROP POLICY IF EXISTS analytics_integrations_worker_discovery ON analytics_integrations;
CREATE POLICY analytics_integrations_worker_discovery ON analytics_integrations
    FOR SELECT
    USING (current_setting('app.analytics_worker', true) = 'true');

COMMENT ON POLICY analytics_integrations_worker_discovery ON analytics_integrations IS
    'The cross-tenant sync sweep sets app.analytics_worker and carries no '
    'tenant GUC. Without this policy its discovery query matched zero rows and '
    'no analytics integration was ever synced — a failure indistinguishable '
    'from an idle worker. SELECT only: the sweep returns tenant_id and every '
    'write is re-scoped per tenant.';

COMMIT;
