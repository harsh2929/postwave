-- 0548_consent_receipt_metadata.sql
--
-- SUB-056 — Consent receipt export to identity wallets
--           (Kantara CR v1.1 / ISO 27560 portable JSON receipts).
--
-- Why this migration:
--   The portable consent receipt (GET /api/v1/subscribers/{id}/consent-receipt.json)
--   constructs an ISO 27560 / Kantara CR v1.1 document from the subscriber's
--   existing consent vector (0318) + consent_receipts history (0140). Two
--   fields the receipt schema mandates have no home today: the organizational
--   policy_uri (the "policyUri" / privacy policy URL the consent was granted
--   under) and a stable organization label for the "piiController" block.
--
--   Rather than overload the tenants row (0001) with marketing-page columns,
--   this migration adds a small per-tenant tenant_consent_receipt_settings
--   table holding the privacy_policy_uri + an optional controller display
--   name + controller contact. One row per tenant. When absent the receipt
--   builder falls back to the tenant name (tenants.name) and omits the URI.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE
-- tenant_consent_receipt_settings.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_consent_receipt_settings (
    tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- The privacy policy URL the consent was granted under. Surfaces as the
    -- ISO 27560 / Kantara CR "policyUri" field. NULL = omitted from receipts.
    privacy_policy_uri   text,
    -- Optional controller display name for the receipt's piiController block.
    -- NULL = fall back to tenants.name.
    controller_name      text,
    -- Optional controller contact (DPO email / address) for the piiController
    -- block. NULL = omitted.
    controller_contact   text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_consent_receipt_settings IS
    'SUB-056 per-tenant organizational context for ISO 27560 / Kantara CR v1.1 portable consent receipts: privacy policy URI + controller name/contact.';

CREATE TRIGGER tenant_consent_receipt_settings_set_updated_at
    BEFORE UPDATE ON tenant_consent_receipt_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_consent_receipt_settings TO postwave_app;

ALTER TABLE tenant_consent_receipt_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_consent_receipt_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_consent_receipt_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_consent_receipt_settings
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
