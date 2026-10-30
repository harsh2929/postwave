-- 0193_compliance_programs.sql
--
-- Refined Compliance tab (was HIPAA). Adds a generic, per-framework
-- attestation store so operators can track SOC 2 / GDPR / CCPA /
-- PCI DSS / ISO 27001 / CAN-SPAM / CASL alongside the existing
-- HIPAA BAA flow.
--
-- HIPAA stays authoritative through the existing hipaa_baa_events
-- table — the new compliance package synthesizes HIPAA into the
-- programs list by reading hipaa_status, rather than duplicating
-- state. That keeps the BAA gate logic (audit retention floor,
-- BYOK enforcement, PHI-ready predicate) in one place.
--
-- Columns:
--   framework         — short slug ("soc2" / "gdpr" / "ccpa" / ...)
--   status            — "attested" / "in_progress" / "revoked"
--   document_path     — URI of the signed agreement / report
--                       (e.g. s3://compliance/soc2-2026.pdf)
--   document_sha256   — hex digest of the canonical document
--   attested_at       — when the operator marked it attested
--   renewal_at        — optional next-review date (annual for most)
--   signer_name       — human counter-signer ("Acme Legal")

CREATE TABLE IF NOT EXISTS compliance_programs (
    tenant_id        uuid        NOT NULL,
    framework        text        NOT NULL,
    status           text        NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('attested', 'in_progress', 'revoked')),
    signed_by_email  text        NOT NULL DEFAULT '',
    signer_name      text        NOT NULL DEFAULT '',
    document_path    text        NOT NULL DEFAULT '',
    document_sha256  text        NOT NULL DEFAULT '',
    notes            text        NOT NULL DEFAULT '',
    attested_at      timestamptz NULL,
    renewal_at       timestamptz NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, framework)
);

CREATE INDEX IF NOT EXISTS compliance_programs_renewal_idx
    ON compliance_programs (tenant_id, renewal_at)
 WHERE renewal_at IS NOT NULL;

-- Event ledger — one row per attest / revoke / renew / amend
-- action so auditors can trace the lifecycle. Mirrors the
-- hipaa_baa_events shape so the EvidenceExportButton can stitch
-- both streams when an operator exports.
CREATE TABLE IF NOT EXISTS compliance_program_events (
    id                bigserial   PRIMARY KEY,
    tenant_id         uuid        NOT NULL,
    framework         text        NOT NULL,
    event_type        text        NOT NULL
        CHECK (event_type IN ('attested', 'revoked', 'renewed', 'amended')),
    signed_by_email   text        NOT NULL DEFAULT '',
    counter_signed_by text        NOT NULL DEFAULT '',
    document_path     text        NOT NULL DEFAULT '',
    document_sha256   text        NOT NULL DEFAULT '',
    notes             text        NOT NULL DEFAULT '',
    metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_program_events_tenant_at_idx
    ON compliance_program_events (tenant_id, framework, at DESC);

-- RLS — same pattern as the surrounding tables.
ALTER TABLE compliance_programs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_programs       FORCE  ROW LEVEL SECURITY;
ALTER TABLE compliance_program_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_program_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON compliance_programs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON compliance_program_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
