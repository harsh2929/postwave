-- 0263_audit_redaction.sql
--
-- PII redaction + field-level encryption for sensitive audit metadata.
--
-- Two new tables and two new audit_log columns:
--
-- 1. audit_redaction_policies — per-tenant rules for what to mask /
--    encrypt in audit_log.metadata. Default-deny list (password,
--    token, api_key, secret, credit_card, ssn, ein, dob) applies to
--    every row written for the tenant; tenants can layer JSONPath-
--    style rules on top for application-specific fields (e.g.
--    `$.billing.card_number`).
--
-- 2. audit_pii_unmask_history — audit trail of every "Reveal PII"
--    request. Answers "who looked at PII and when" — required by
--    SOC 2 CC6.1 and GDPR Art. 32.
--
-- audit_log columns:
--
--   metadata_encrypted    — bytea, envelope-encrypted blob holding
--                            the original (unredacted) metadata. Only
--                            decryptable by callers holding the
--                            audit:read_pii scope (gated server-side).
--   redacted_field_hashes — jsonb mapping path -> SHA-256 hash of
--                            value, so a reviewer can answer
--                            "did this row touch token X?" without
--                            ever seeing the plaintext.
--
-- Compliance gap-doc category: Compliance, priority P0.

BEGIN;

-- audit_redaction_policies: per-tenant JSONPath rules + default-deny list.
-- One row per tenant; the application reads the row on every audit write
-- (with a small in-memory cache to keep the hot path fast).
CREATE TABLE IF NOT EXISTS audit_redaction_policies (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,
    -- Comma-separated list of sensitive field names to always redact.
    -- Defaults cover the common cases; tenants can append (never trim
    -- below the floor — enforced in the Go layer).
    default_redacted_fields text NOT NULL DEFAULT 'password,token,api_key,secret,credit_card,ssn,ein,dob',
    -- JSONPath rules: [{"path": "$.payment.id", "action": "mask"|"encrypt"|"hash"}]
    --   "mask"    — replace with REDACTED sentinel
    --   "encrypt" — move value into metadata_encrypted, replace with sentinel
    --   "hash"    — store SHA-256 in redacted_field_hashes, replace with sentinel
    jsonpath_rules          jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_redaction_policies_tenant
    ON audit_redaction_policies (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_redaction_policies TO postwave_app;

ALTER TABLE audit_redaction_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_redaction_policies AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Extend audit_log with encryption + redaction tracking columns.
-- Both default-null so historical rows stay readable without backfill.
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS metadata_encrypted bytea,
    ADD COLUMN IF NOT EXISTS redacted_field_hashes jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Partial index: most rows have no redaction so an unconditional index
-- would balloon size; the partial form only carries the interesting
-- subset (rows that actually had fields redacted).
CREATE INDEX IF NOT EXISTS idx_audit_log_redacted_fields
    ON audit_log (tenant_id, at DESC)
 WHERE redacted_field_hashes <> '{}'::jsonb;

-- audit_pii_unmask_history: append-only ledger of PII unmask requests.
-- One row per "Reveal PII" click. Keyed by the audit_log id so a
-- reviewer can ask "show me everyone who has unmasked this row".
CREATE TABLE IF NOT EXISTS audit_pii_unmask_history (
    id                      bigserial PRIMARY KEY,
    tenant_id               uuid NOT NULL,
    audit_log_id            bigint NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE,
    unmasked_by_user_id     uuid,
    unmasked_by_actor_label text,
    unmasked_at             timestamptz NOT NULL DEFAULT now(),
    unmasked_reason         text
);

CREATE INDEX IF NOT EXISTS idx_audit_pii_unmask_history_audit_id
    ON audit_pii_unmask_history (tenant_id, audit_log_id, unmasked_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_pii_unmask_history_tenant_at
    ON audit_pii_unmask_history (tenant_id, unmasked_at DESC);

GRANT SELECT, INSERT ON audit_pii_unmask_history TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_pii_unmask_history_id_seq TO postwave_app;

ALTER TABLE audit_pii_unmask_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON audit_pii_unmask_history AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Seed the default policy for every tenant that already has audit
-- history. No-op for fresh deployments. ON CONFLICT lets the migration
-- be safely re-run.
INSERT INTO audit_redaction_policies (tenant_id)
SELECT DISTINCT tenant_id FROM audit_log
ON CONFLICT (tenant_id) DO NOTHING;

-- The Reveal-PII click itself writes a first-class audit_log row with
-- action='audit.pii_unmask' (see apps/api/internal/handlers/audit_extras.go).
-- That row obeys retention + the Merkle hash-chain and is NOT redacted
-- regardless of caller scope; it is the canonical answer to "who has
-- ever decrypted this row".

COMMIT;
