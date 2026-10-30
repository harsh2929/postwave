-- Push-only support providers (Freshchat, Tidio, and any chat tool without a
-- ticket-shaped bulk-list API) deliver conversations via webhooks to a public
-- per-integration ingest URL carrying an opaque token. The public handler
-- resolves the owning integration by that token before tenant context exists,
-- then re-enters tenant scope to land tickets. A SELECT-only lookup policy
-- keyed by the token allows that pre-tenant resolution; a dummy app.tenant_id
-- keeps tenant_isolation from evaluating an unset GUC. Mirrors 1610-1612.

CREATE INDEX IF NOT EXISTS support_integrations_ingest_idx
    ON support_integrations ((settings->>'support_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS support_integrations_ingest_lookup ON support_integrations;
CREATE POLICY support_integrations_ingest_lookup ON support_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'support_ingest_token' = NULLIF(current_setting('app.support_ingest_token', true), '')
    );
