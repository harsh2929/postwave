-- Push-only loyalty providers (Growave, Marsello, and any program with no bulk
-- read API) deliver data via webhooks to a public per-integration ingest URL
-- carrying an opaque token. The public handler resolves the owning integration
-- by that token before tenant context exists, then re-enters tenant scope to
-- land members/events. A SELECT-only lookup policy keyed by the token allows
-- that pre-tenant resolution; a dummy app.tenant_id keeps tenant_isolation from
-- evaluating an unset GUC. Mirrors 1610/1611 (analytics CDP ingest).

CREATE INDEX IF NOT EXISTS loyalty_integrations_ingest_idx
    ON loyalty_integrations ((settings->>'loyalty_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS loyalty_integrations_ingest_lookup ON loyalty_integrations;
CREATE POLICY loyalty_integrations_ingest_lookup ON loyalty_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'loyalty_ingest_token' = NULLIF(current_setting('app.loyalty_ingest_token', true), '')
    );
