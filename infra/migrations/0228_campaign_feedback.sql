-- 0228_campaign_feedback.sql
--
-- Workstream 2 (campaign-manager polish): per-campaign collaborative
-- feedback threads. Mailchimp surfaces "Add a comment" beside a draft
-- so reviewers can leave notes that the author resolves. We give each
-- campaign its own append-only comment ledger with a resolved_at
-- nullable column so the UI can hide resolved notes without losing
-- the audit trail.

BEGIN;

CREATE TABLE campaign_feedback (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    author_user_id  uuid,
    author_label    text NOT NULL DEFAULT '',
    body            text NOT NULL,
    resolved_at     timestamptz,
    resolved_by     uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_feedback_tenant_campaign_idx
    ON campaign_feedback (tenant_id, campaign_id, created_at DESC);

CREATE INDEX campaign_feedback_unresolved_idx
    ON campaign_feedback (tenant_id, campaign_id)
    WHERE resolved_at IS NULL;

CREATE TRIGGER campaign_feedback_set_updated_at
    BEFORE UPDATE ON campaign_feedback
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_feedback TO postwave_app;

ALTER TABLE campaign_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_feedback
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_feedback
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
