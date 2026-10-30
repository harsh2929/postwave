-- 0363_subscriber_imports_consent_tags_properties.sql
--
-- A11 (2026-06-10 desktop audit): the import wizard's consent-proof,
-- tagging and property-creation steps were collected client-side but
-- silently dropped — PATCH /api/v1/subscriber-imports/{id} only
-- persisted `mapping` + `on_existing`. This lands the job-level
-- columns so the operator's answers survive preview → confirm and the
-- worker can apply them per row:
--
--   * consent_source / consent_source_url / consent_captured_at —
--     consent provenance asserted for everyone in the file. Applied
--     as one consent_records proof row per imported subscriber (the
--     0248 ledger) + subscribers.consent_source / consent_timestamp.
--   * tags — job-level tags appended (deduped) to every imported /
--     updated subscriber, on top of any per-row tags column.
--   * auto_create_properties — when the mapping references a custom
--     field key missing from the tenant_custom_fields registry,
--     register it (type 'string') instead of leaving it untyped.
--
-- No new tables, so the existing 0134 tenant_visible RLS policy
-- (NULLIF(current_setting('app.tenant_id', true), '')::uuid OR
-- app.outbox_worker) keeps covering the rows.

BEGIN;

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS consent_source         text,
    ADD COLUMN IF NOT EXISTS consent_source_url     text,
    ADD COLUMN IF NOT EXISTS consent_captured_at    timestamptz,
    ADD COLUMN IF NOT EXISTS tags                   text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS auto_create_properties boolean NOT NULL DEFAULT false;

COMMIT;
