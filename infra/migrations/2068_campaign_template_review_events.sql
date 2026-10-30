-- Version-bound, append-only collaboration for tenant-owned email templates.
-- migration-execution: phased
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_tenant_id_id_review_uidx
    ON campaign_templates (tenant_id, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_linked_blocks_gin_idx
    ON campaign_templates USING gin (design_metadata jsonb_path_ops)
    WHERE tenant_id IS NOT NULL AND design_metadata ? 'moosewave_linked_blocks';

BEGIN;

ALTER TABLE campaign_templates
    ADD CONSTRAINT campaign_templates_tenant_id_id_for_reviews
    UNIQUE USING INDEX campaign_templates_tenant_id_id_review_uidx;

CREATE TABLE campaign_template_review_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_id uuid NOT NULL,
    template_version bigint NOT NULL CHECK (template_version > 0),
    actor_user_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('comment', 'approve', 'request_changes')),
    body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_template_review_body_required CHECK (
        kind = 'approve' OR char_length(btrim(body)) > 0
    ),
    CONSTRAINT campaign_template_review_template_tenant_fk
        FOREIGN KEY (tenant_id, template_id) REFERENCES campaign_templates(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT campaign_template_review_actor_tenant_fk
        FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX campaign_template_review_events_template_idx
    ON campaign_template_review_events (tenant_id, template_id, template_version, created_at DESC);

GRANT SELECT, INSERT ON campaign_template_review_events TO postwave_app;
ALTER TABLE campaign_template_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_review_events FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_review_events_tenant_isolation
    ON campaign_template_review_events AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
