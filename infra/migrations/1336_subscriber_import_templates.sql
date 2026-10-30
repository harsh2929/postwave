-- 1336_subscriber_import_templates.sql
--
-- SUB-109 — Save column mapping as a reusable template for recurring imports.
--
-- The import wizard already detects + lets the operator adjust the CSV
-- column->field mapping during the preview phase (stored on the
-- subscriber_imports.mapping jsonb column). For a team that imports the same
-- export every week (e.g. a nightly CRM dump with a fixed header layout)
-- re-doing that mapping by hand on every run is pure toil. This table lets an
-- operator name + persist a mapping once and re-apply it on the next import.
--
-- A template is a tenant-scoped, named bag holding:
--   * mapping     — the jsonb column->field map, byte-identical in shape to
--                   subscriber_imports.mapping so the wizard can drop it in.
--   * source_hint — a free-text label for the source the mapping fits
--                   (e.g. "Salesforce nightly export", "Mailchimp"). Lets the
--                   UI suggest a template by source without inspecting headers.
--
-- Tenant-scoped + RLS-gated on app.tenant_id, following the shape of
-- 1300_subscriber_bulk_recovery.sql / 0303_subscriber_signup_source.sql. The
-- policy reads the tenant via NULLIF(current_setting('app.tenant_id', true),
-- '')::uuid so an unset GUC yields NULL (no rows) rather than crashing on a
-- raw ::uuid cast of the empty string.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_import_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    -- mapping is the column->field map, same shape as
    -- subscriber_imports.mapping. Defaults to an empty object so a row is
    -- always well-formed even if a client posts no mapping.
    mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- source_hint is an optional free-text label for the source this mapping
    -- fits ("Salesforce nightly export"). Empty string = unspecified.
    source_hint text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Names are unique per tenant so "Save as template" can upsert by name and
-- the dropdown never shows two identically-named templates. citext would be
-- nicer for case-insensitive uniqueness but the column is plain text to keep
-- the constraint simple; the UI trims + the handler lower-cases on lookup.
CREATE UNIQUE INDEX IF NOT EXISTS subscriber_import_templates_tenant_name_idx
    ON subscriber_import_templates (tenant_id, name);

-- Listing is "all templates for this tenant, newest first"; the composite
-- index serves the RLS-narrowed ORDER BY created_at DESC directly.
CREATE INDEX IF NOT EXISTS subscriber_import_templates_tenant_created_idx
    ON subscriber_import_templates (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_import_templates TO postwave_app;

ALTER TABLE subscriber_import_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_import_templates FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_import_templates;
CREATE POLICY tenant_isolation ON subscriber_import_templates
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
