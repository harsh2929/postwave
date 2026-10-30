-- 0415_custom_fields_richer_types.sql
--
-- SUB-006 — Richer custom-attribute types.
--
-- The tenant_custom_fields registry (migration 0036) supports only four
-- value types: string / number / boolean / date, pinned by a CHECK
-- constraint. Klaviyo and Mailchimp both expose richer attribute types —
-- enum / multi-select, array, object/nested, and format-validated scalars
-- (email / url / phone / region) — plus per-attribute metadata flags for
-- PII and encryption.
--
-- This migration extends the registry so a tenant can declare these richer
-- types and attach type-specific metadata:
--
--   * Widens the `type` CHECK to add: enum, array, object, email, url,
--     phone, region.
--   * Adds `config` (jsonb, nullable) for type-specific metadata —
--     enum options, array item type, object schema, format pattern, and the
--     pii_flag / encryption_flag booleans.
--   * Adds `validation_rule` (text, nullable) for a regex/format constraint
--     applied at write time by the validator.
--
-- Both new columns are nullable so the existing four scalar types keep
-- working untouched (config/validation_rule stay NULL). RLS + the unique
-- (tenant_id, key) index from 0036 are inherited unchanged.

BEGIN;

-- Drop the old four-type CHECK and re-add a widened one. The constraint
-- name is the Postgres default from 0036 (tenant_custom_fields_type_check),
-- guarded so a re-run on a fixture that already widened it is a no-op.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_custom_fields_type_check'
    ) THEN
        ALTER TABLE tenant_custom_fields
            DROP CONSTRAINT tenant_custom_fields_type_check;
    END IF;
END$$;

ALTER TABLE tenant_custom_fields
    ADD COLUMN IF NOT EXISTS config          jsonb,
    ADD COLUMN IF NOT EXISTS validation_rule text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_custom_fields_type_chk'
    ) THEN
        ALTER TABLE tenant_custom_fields
            ADD CONSTRAINT tenant_custom_fields_type_chk
            CHECK (type IN (
                'string',
                'number',
                'boolean',
                'date',
                'enum',
                'array',
                'object',
                'email',
                'url',
                'phone',
                'region'
            ));
    END IF;
END$$;

COMMIT;
