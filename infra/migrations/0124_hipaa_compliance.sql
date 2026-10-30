-- 0124_hipaa_compliance.sql
--
-- HIPAA Business Associate Agreement (BAA) path. When a tenant signs a
-- BAA, Postwave is contractually a Business Associate handling PHI on
-- the customer's (Covered Entity's) behalf. The schema extension
-- captures the BAA execution + applies safer defaults:
--
--   * audit_log retention bumped to 6 years (HIPAA §164.530(j)(2)
--     minimum). The privacy retention layer reads this and overrides
--     the tenant-chosen value when hipaa_baa_signed=true.
--
--   * suppression list retention bumped permanently (no auto-prune of
--     unsubscribe records — HIPAA wants the audit trail intact).
--
--   * Per-tenant KEK is required (BYOK enforced when hipaa_baa_signed).
--     We don't add a CHECK here because BYOK rollout happens via the
--     existing tenant_keys flow; the API layer rejects sends if a
--     BAA-signed tenant has no active tenant key.
--
--   * Recipient logging policy: when phi_sensitive=true on a row, the
--     audit_log metadata may NOT contain raw recipient PII (we log a
--     SHA-256 fingerprint instead). The recipient_fingerprint column
--     supports the alternate-evidence query path.
--
-- We separate `hipaa_baa_signed` from `compliance_overrides` so a
-- BAA can be revoked + re-issued without rebuilding the override.

BEGIN;

-- 1) BAA execution + per-tenant compliance flags.
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS hipaa_baa_signed     boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS hipaa_baa_signed_at  timestamptz,
    ADD COLUMN IF NOT EXISTS hipaa_baa_revoked_at timestamptz,
    -- Operator-signed PDF retention key (object-storage path).
    ADD COLUMN IF NOT EXISTS hipaa_baa_document_path text,
    -- Optional: each BAA has a counter-signed PDF stored alongside.
    ADD COLUMN IF NOT EXISTS hipaa_baa_document_sha256 text;

CREATE INDEX IF NOT EXISTS idx_tenants_hipaa
    ON tenants (hipaa_baa_signed)
    WHERE hipaa_baa_signed = true;

-- 2) Recipient-fingerprint column on audit_log so PHI-sensitive
-- actions don't have to embed raw email/name in metadata JSON. The
-- audit middleware computes sha256(recipient_email) when the tenant
-- has hipaa_baa_signed=true.
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS recipient_fingerprint bytea;

CREATE INDEX IF NOT EXISTS idx_audit_log_recipient_fingerprint
    ON audit_log (tenant_id, recipient_fingerprint, at DESC)
    WHERE recipient_fingerprint IS NOT NULL;

-- 3) BAA event ledger — every signature, revocation, renewal goes
-- here. Provides the audit-chain operators show to assessors during
-- a HIPAA security review.
CREATE TABLE IF NOT EXISTS hipaa_baa_events (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL,
    event_type        text NOT NULL CHECK (event_type IN ('signed','revoked','renewed','amended')),
    document_path     text,
    document_sha256   text,
    signed_by_email   text,
    counter_signed_by text,            -- Postwave-side signer
    notes             text,
    at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hipaa_baa_events_tenant
    ON hipaa_baa_events (tenant_id, at DESC);

GRANT SELECT, INSERT ON hipaa_baa_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE hipaa_baa_events_id_seq TO postwave_app;

ALTER TABLE hipaa_baa_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON hipaa_baa_events AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- 4) Force a minimum retention floor for BAA-signed tenants. The
-- retention_policies row may exist with a tenant-chosen value; the
-- application layer (privacy.go) reads hipaa_baa_signed and applies
-- max(tenant_choice, hipaa_floor).

COMMIT;
