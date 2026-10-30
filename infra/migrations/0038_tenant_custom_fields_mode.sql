-- 0038_tenant_custom_fields_mode.sql
--
-- Adds a per-tenant override for the custom-fields validator.
--
--   strict — reject any custom_fields key that isn't pre-registered in
--            tenant_custom_fields. Use when the tenant's schema is
--            authoritative (e.g. enterprise contracts).
--   auto   — register unknown keys on first write, inferring the type
--            from the value. Default; ideal for migration imports.
--   off    — legacy passthrough; no validation, no auto-register.
--            Kept for safety / ops emergencies.
--
-- A NULL column means "use the global default" (currently auto).
-- The CHECK clamps the column to known values so a typo can't silently
-- become "off". The validator's ParseMode falls back to default on any
-- unknown string anyway, but the CHECK catches the bug at write time.

BEGIN;

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS custom_fields_mode text
        CHECK (custom_fields_mode IN ('strict', 'auto', 'off'));

COMMIT;
