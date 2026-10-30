-- Segment pushes identify/track events to a public per-integration ingest URL
-- carrying an opaque token. The public handler resolves the owning integration
-- by that token before tenant context exists, then re-enters tenant scope to
-- land profiles/events. A SELECT-only lookup policy keyed by the token allows
-- that pre-tenant resolution; a dummy app.tenant_id keeps tenant_isolation from
-- evaluating an unset GUC.

CREATE INDEX IF NOT EXISTS analytics_integrations_segment_ingest_idx
    ON analytics_integrations ((settings->>'segment_ingest_token'))
    WHERE provider = 'segment' AND status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS analytics_integrations_segment_ingest_lookup ON analytics_integrations;
CREATE POLICY analytics_integrations_segment_ingest_lookup ON analytics_integrations
    FOR SELECT
    USING (
        provider = 'segment'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'segment_ingest_token' = NULLIF(current_setting('app.analytics_ingest_token', true), '')
    );
