-- G-15 WhatsApp Business Platform: per-tenant WhatsApp message template
-- registry. Meta's Cloud API only allows *approved* templates to be sent
-- (per-message billing model, July-2025) and approval is granted per
-- (name, language) pair, not per generic template id — so this is a
-- dedicated table rather than a reuse of the generic omni_message_templates
-- store, which has no language axis.

CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                text NOT NULL,
    language            text NOT NULL,
    category            text NOT NULL DEFAULT 'utility'
                        CHECK (category IN ('utility', 'marketing', 'authentication')),
    body                text NOT NULL,
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'paused', 'disabled')),
    provider_template_id text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name, language)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS whatsapp_message_templates_tenant_status_idx
    ON whatsapp_message_templates (tenant_id, status);

DROP TRIGGER IF EXISTS whatsapp_message_templates_set_updated_at ON whatsapp_message_templates;
CREATE TRIGGER whatsapp_message_templates_set_updated_at
    BEFORE UPDATE ON whatsapp_message_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_message_templates TO postwave_app;

ALTER TABLE whatsapp_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_message_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON whatsapp_message_templates;
CREATE POLICY tenant_isolation ON whatsapp_message_templates
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
