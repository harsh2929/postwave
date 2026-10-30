-- 0145_utm_templates.sql
--
-- UTM auto-tagging templates.
--
-- Two scope levels:
--   * tenant default  — one row per tenant with campaign_id IS NULL
--   * campaign override — one row per campaign, takes precedence
--
-- Each template provides utm_source / utm_medium / utm_campaign /
-- utm_term / utm_content. Tokens {{slug}} {{name}} {{date}} are
-- substituted at send time by the rewriter that consumes this
-- table.

BEGIN;

CREATE TABLE IF NOT EXISTS utm_templates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- NULL = tenant default; non-null = per-campaign override.
    campaign_id  uuid,
    utm_source   text,
    utm_medium   text,
    utm_campaign text,
    utm_term     text,
    utm_content  text,
    enabled      boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One default per tenant, one override per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_templates_tenant_default
    ON utm_templates (tenant_id) WHERE campaign_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_templates_campaign
    ON utm_templates (tenant_id, campaign_id) WHERE campaign_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON utm_templates TO postwave_app;

ALTER TABLE utm_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON utm_templates AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
