-- 1406_campaign_org_tags.sql
--
-- G12 follow-up: organizational tags ON campaigns (distinct from
-- campaigns.target_tag_ids, which targets SUBSCRIBER tags for audience
-- selection). These are free-text labels operators attach to campaigns
-- for grouping — the missing foundation for the list view's bulk Tag
-- action.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_org_tags (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    tag         text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, tag)
);

CREATE INDEX IF NOT EXISTS campaign_org_tags_campaign_idx
    ON campaign_org_tags (tenant_id, campaign_id);
CREATE INDEX IF NOT EXISTS campaign_org_tags_tag_idx
    ON campaign_org_tags (tenant_id, tag);

GRANT SELECT, INSERT, DELETE ON campaign_org_tags TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_org_tags_id_seq TO postwave_app;

ALTER TABLE campaign_org_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_org_tags FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_org_tags
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON campaign_org_tags
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
