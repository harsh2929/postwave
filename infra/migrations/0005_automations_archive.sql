-- 0005_automations_archive.sql
--
-- Persists migrated automations and historical campaign archives in
-- Postwave-owned tables. These are the "write side" of the migration
-- translator (services/migration/internal/translator/listmonk).
--
-- Listmonk has no native automation runtime, so automations are stored here
-- as canonical AST rows for services/automation to execute later. Campaign
-- archives are read-only history (never re-sent), surfaced to the reader UI.

BEGIN;

CREATE TABLE automations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                text NOT NULL,
    status              text NOT NULL DEFAULT 'draft',
    triggers            jsonb NOT NULL DEFAULT '[]'::jsonb,
    nodes               jsonb NOT NULL DEFAULT '[]'::jsonb,
    edges               jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_definition   text,
    source_platform     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automations_tenant_status_idx ON automations (tenant_id, status);

CREATE TRIGGER automations_set_updated_at
    BEFORE UPDATE ON automations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO postwave_app;

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON automations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);


CREATE TABLE campaign_archive (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_id           text,
    subject             text NOT NULL,
    html                text NOT NULL DEFAULT '',
    text                text NOT NULL DEFAULT '',
    sent_at             timestamptz,
    recipients_count    integer NOT NULL DEFAULT 0,
    opens               integer NOT NULL DEFAULT 0,
    clicks              integer NOT NULL DEFAULT 0,
    source_platform     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_platform, source_id)
);

CREATE INDEX campaign_archive_tenant_sent_idx
    ON campaign_archive (tenant_id, sent_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_archive TO postwave_app;

ALTER TABLE campaign_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_archive FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_archive
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
