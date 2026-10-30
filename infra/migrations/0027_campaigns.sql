-- 0027_campaigns.sql
--
-- Tenant-scoped Postwave campaign drafts. Listmonk remains the send engine,
-- but the proprietary app owns draft metadata, editor content, scheduling
-- intent, and the tenant boundary before anything is promoted to the engine.

BEGIN;

CREATE TABLE campaigns (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           text NOT NULL,
    subject        text NOT NULL,
    status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused')),
    body_html      text,
    body_mjml      text,
    segment_id     uuid,
    scheduled_at   timestamptz,
    sent_at        timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaigns_tenant_status_updated_idx
    ON campaigns (tenant_id, status, updated_at DESC);
CREATE INDEX campaigns_tenant_scheduled_idx
    ON campaigns (tenant_id, scheduled_at)
    WHERE scheduled_at IS NOT NULL;

ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_tenant_segment_fk
    FOREIGN KEY (tenant_id, segment_id)
    REFERENCES segments(tenant_id, id)
    ON DELETE SET NULL (segment_id);

CREATE TRIGGER campaigns_set_updated_at
    BEFORE UPDATE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns TO postwave_app;

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaigns
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
