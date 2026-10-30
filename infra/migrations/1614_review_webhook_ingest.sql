-- Push-only review desks (and any review program delivering data via webhooks)
-- post reviews to a public per-integration ingest URL carrying an opaque token.
-- The public handler resolves the owning integration by that token before tenant
-- context exists, then re-enters tenant scope to land reviews. A SELECT-only
-- lookup policy keyed by the token allows that pre-tenant resolution; a dummy
-- app.tenant_id keeps tenant_isolation from evaluating an unset GUC. Mirrors
-- 1612 (loyalty webhook ingest) / 1610-1611 (analytics CDP ingest).

CREATE INDEX IF NOT EXISTS review_integrations_ingest_idx
    ON review_integrations ((settings->>'review_ingest_token'))
    WHERE status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS review_integrations_ingest_lookup ON review_integrations;
CREATE POLICY review_integrations_ingest_lookup ON review_integrations
    FOR SELECT
    USING (
        status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'review_ingest_token' = NULLIF(current_setting('app.review_ingest_token', true), '')
    );
