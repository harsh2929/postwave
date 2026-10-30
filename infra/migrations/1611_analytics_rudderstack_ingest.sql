-- RudderStack (Segment-spec CDP) pushes identify/track events to a public
-- per-integration ingest URL carrying an opaque token, exactly like Segment
-- (see 1610). The public handler resolves the owning integration by that token
-- before tenant context exists, then re-enters tenant scope to land
-- profiles/events. A SELECT-only lookup policy keyed by the token allows that
-- pre-tenant resolution; a dummy app.tenant_id keeps tenant_isolation from
-- evaluating an unset GUC.

CREATE INDEX IF NOT EXISTS analytics_integrations_rudderstack_ingest_idx
    ON analytics_integrations ((settings->>'rudderstack_ingest_token'))
    WHERE provider = 'rudderstack' AND status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS analytics_integrations_rudderstack_ingest_lookup ON analytics_integrations;
CREATE POLICY analytics_integrations_rudderstack_ingest_lookup ON analytics_integrations
    FOR SELECT
    USING (
        provider = 'rudderstack'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'rudderstack_ingest_token' = NULLIF(current_setting('app.analytics_ingest_token', true), '')
    );
