-- 0275_audit_sink_output_format.sql
--
-- Adds an output_format column to audit_sinks so each sink can opt
-- into emitting OCSF 1.8 (postwave_native by default for backward
-- compatibility).
--
-- Why: every credible 2026 SIEM (Splunk, Datadog Cloud SIEM, Microsoft
-- Sentinel Data Lake, AWS Security Lake, Google SecOps) natively
-- ingests OCSF. Without this column, our proprietary JSON envelope is
-- shadow-banned by detection-engineering teams that refuse to write
-- per-vendor parsers.
--
-- Values:
--   postwave_native  (default) — the historic AuditRow shape.
--   ocsf_1_8        — OCSF 1.8 envelope per
--                     apps/api/internal/auditsink/ocsf/mapper.go.
--
-- Migration is additive: existing rows default to postwave_native so
-- no downstream consumer breaks. Switch is per-sink, opt-in via
-- PATCH /api/v1/audit-sinks/{id}.

BEGIN;

ALTER TABLE audit_sinks
  ADD COLUMN IF NOT EXISTS output_format text NOT NULL DEFAULT 'postwave_native';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_sinks_output_format_check'
  ) THEN
    ALTER TABLE audit_sinks
      ADD CONSTRAINT audit_sinks_output_format_check
      CHECK (output_format IN ('postwave_native', 'ocsf_1_8'));
  END IF;
END $$;

-- OCSF sinks are likely the minority; partial index keeps the lookup
-- cheap when the worker enumerates enabled sinks.
CREATE INDEX IF NOT EXISTS idx_audit_sinks_output_format
  ON audit_sinks (tenant_id, output_format)
  WHERE enabled = true;

-- RLS already covers the new column via the existing tenant_visible
-- ALL policy in 0123_audit_sinks_and_merkle.sql. The GUC-based
-- predicate (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
-- is unaffected by the column addition.

COMMIT;
