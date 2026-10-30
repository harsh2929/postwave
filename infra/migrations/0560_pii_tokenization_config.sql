-- 0560_pii_tokenization_config.sql
--
-- SUB-072 — AI gateway / privacy firewall for prompts (field-sensitivity config).
--
-- Why this migration:
--   The PII gateway (apps/api/internal/pii_gateway) tokenizes sensitive
--   subscriber field values before a prompt is handed to an LLM and detokenizes
--   the model's response on the way back. The well-known identifier fields
--   (email, phone) are always sensitive, but which *custom* fields carry PII is
--   tenant-specific: one workspace's "notes" field is harmless, another's holds
--   a government id. This table is the per-tenant control surface — one row per
--   (tenant, field_name) the operator has marked PII-sensitive — read by the
--   sanitizer at prompt-render time. Absent row = field is NOT tokenized (the
--   conservative default that preserves the historic raw-prompt behaviour for a
--   tenant that never opts in).
--
--   field_name is the custom_fields / merge_fields key (free text, lower-cased
--   by the application before write). built_in marks the always-sensitive
--   identifier pseudo-fields ('email','phone') so the UI can render them as
--   locked-on toggles distinct from operator-added custom fields.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE pii_tokenization_config.

BEGIN;

CREATE TABLE IF NOT EXISTS pii_tokenization_config (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The custom_fields / merge_fields key (or built-in identifier name) this
    -- sensitivity flag applies to. Lower-cased by the application before write.
    field_name      text NOT NULL,
    -- Whether the sanitizer should tokenize this field's value in prompts.
    sensitive       boolean NOT NULL DEFAULT true,
    -- true for the always-sensitive identifier pseudo-fields the UI renders
    -- as locked-on (email / phone); false for operator-added custom fields.
    built_in        boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- One row per (tenant, field) — an upsert flips the flag in place.
    UNIQUE (tenant_id, field_name)
);

COMMENT ON TABLE pii_tokenization_config IS
    'SUB-072 per-tenant PII gateway field-sensitivity flags: which subscriber fields the sanitizer tokenizes before an LLM call.';

-- Primary read shape: "all sensitivity flags for this tenant" loaded once per
-- prompt render.
CREATE INDEX IF NOT EXISTS pii_tokenization_config_tenant_idx
    ON pii_tokenization_config (tenant_id);

CREATE TRIGGER pii_tokenization_config_set_updated_at
    BEFORE UPDATE ON pii_tokenization_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON pii_tokenization_config TO postwave_app;

ALTER TABLE pii_tokenization_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_tokenization_config FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pii_tokenization_config
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON pii_tokenization_config
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
