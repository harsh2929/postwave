-- 1405_campaign_translations.sql
--
-- G19 (campaigns 2026): multi-language variant matrix. One campaign,
-- N authored localizations — each (campaign, locale) carries its own
-- subject + body. Distinct from the smart-translations dictionary
-- (migration 0296), which is render-time AI translation of one canonical
-- body; these are operator-authored per-language variants.
--
-- Queue-fill routing (pick the recipient's locale variant at send) +
-- the per-locale aggregated report are the documented follow-ups; this
-- ships the authored matrix + its CRUD.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_translations (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    locale      text        NOT NULL,            -- BCP-47-ish, e.g. 'es', 'fr-CA'
    subject     text        NOT NULL DEFAULT '',
    body_html   text        NOT NULL DEFAULT '',
    body_mjml   text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, locale)
);

CREATE INDEX IF NOT EXISTS campaign_translations_campaign_idx
    ON campaign_translations (tenant_id, campaign_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_translations TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_translations_id_seq TO postwave_app;

ALTER TABLE campaign_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_translations FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_translations
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON campaign_translations
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
