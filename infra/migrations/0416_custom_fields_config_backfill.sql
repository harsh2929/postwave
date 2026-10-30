-- 0416_custom_fields_config_backfill.sql
--
-- SUB-006 — Richer custom-attribute types (backfill half).
--
-- Companion to 0415, which added the nullable `config` (jsonb) and
-- `validation_rule` (text) columns to tenant_custom_fields. Existing rows
-- predate the richer-types feature, so they carry no type-specific metadata:
-- their config/validation_rule are semantically "none". 0415 already leaves
-- both NULL on add, so this backfill is a defensive no-op normalisation that
-- pins every legacy row to an explicit NULL (guarding against any fixture
-- path that might have written a non-NULL default) and documents the
-- intended steady state.

BEGIN;

UPDATE tenant_custom_fields
   SET config = NULL,
       validation_rule = NULL
 WHERE type IN ('string', 'number', 'boolean', 'date')
   AND (config IS NOT NULL OR validation_rule IS NOT NULL);

COMMIT;
