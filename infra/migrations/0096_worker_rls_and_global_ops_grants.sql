-- 0096_worker_rls_and_global_ops_grants.sql
--
-- Local release rehearsals surfaced two classes of background-worker
-- breakage:
--
--   1. Global ops tables created without explicit runtime grants.
--      They are intentionally not tenant-scoped, but the postwave_app role
--      still needs table privileges to prune telemetry and drain retry queues.
--
--   2. Worker sweeps that run without app.tenant_id hitting older RLS
--      policies that cast the tenant setting directly to uuid.
--      Pooled connections can retain an empty custom GUC, which
--      makes that cast fail before permissive worker policies can admit the
--      query. Use NULLIF(..., '')::uuid everywhere these worker paths touch.

BEGIN;

-- ---------------------------------------------------------------------------
-- Global ops tables: no tenant scope, explicit runtime access.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON web_vitals_events TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stripe_webhook_attempts TO postwave_app;

-- ---------------------------------------------------------------------------
-- Send-loop worker discovery.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON tenant_sending_settings;
DROP POLICY IF EXISTS tenant_visible ON tenant_sending_settings;
CREATE POLICY tenant_visible ON tenant_sending_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON tenant_send_rate_buckets;
DROP POLICY IF EXISTS tenant_visible ON tenant_send_rate_buckets;
CREATE POLICY tenant_visible ON tenant_send_rate_buckets
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON campaign_recipients;
DROP POLICY IF EXISTS tenant_visible ON campaign_recipients;
DROP POLICY IF EXISTS campaign_recipients_worker_select ON campaign_recipients;
CREATE POLICY tenant_visible ON campaign_recipients
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY campaign_recipients_worker_select ON campaign_recipients
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------------
-- Outbound webhook worker discovery + delivery lease paths.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_visible ON outbound_webhooks;
CREATE POLICY tenant_visible ON outbound_webhooks
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON outbound_webhook_deliveries;
CREATE POLICY tenant_visible ON outbound_webhook_deliveries
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
