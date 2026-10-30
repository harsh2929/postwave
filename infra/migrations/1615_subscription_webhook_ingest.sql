-- Push-only subscription/shipping desks (Ordergroove, Wonderment, and any
-- program with no bulk read API) deliver data via webhooks to a public
-- per-integration ingest URL carrying an opaque token. The public handler
-- resolves the owning integration by that token before tenant context exists,
-- then re-enters tenant scope to land subscriptions/shipments/events. A
-- SELECT-only lookup policy keyed by the token allows that pre-tenant
-- resolution; a dummy app.tenant_id keeps tenant_isolation from evaluating an
-- unset GUC. Mirrors 1610-1614 (analytics/loyalty/support/review ingest).

CREATE INDEX IF NOT EXISTS subscription_integrations_ingest_idx
    ON subscription_integrations ((settings->>'subscription_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS subscription_integrations_ingest_lookup ON subscription_integrations;
CREATE POLICY subscription_integrations_ingest_lookup ON subscription_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'subscription_ingest_token' = NULLIF(current_setting('app.subscription_ingest_token', true), '')
    );
