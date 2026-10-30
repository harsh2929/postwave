-- 0086_dmarc_reports.sql
--
-- Aggregate DMARC report ingestion (Layer 3, Postwave deliverability service).
-- Companion to the parser at services/deliverability/internal/auth/dmarc_reports.go.
--
-- The 0067 migration produced a denormalised dmarc_reports flat table that
-- was never wired up. This migration replaces it with the schema the IMAP
-- ingestion pipeline actually persists into:
--   - dmarc_aggregate_reports : one row per ESP-supplied report XML.
--   - dmarc_aggregate_records : one row per (source_ip, count) record inside.
-- Idempotency is enforced by the (tenant_id, org_name, report_id) UNIQUE.

CREATE TABLE IF NOT EXISTS dmarc_aggregate_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  org_name text NOT NULL,                  -- reporter (Google, Yahoo, etc.)
  report_id text NOT NULL,                 -- their report id
  date_range_begin timestamptz NOT NULL,
  date_range_end timestamptz NOT NULL,
  domain text NOT NULL,                    -- the domain the report is about
  policy_p text,                           -- none / quarantine / reject
  policy_sp text,
  policy_pct int,
  raw_xml bytea,                           -- the original report (for re-parsing)
  ingested_at timestamptz NOT NULL DEFAULT now(),
  source_message_id text,                  -- IMAP message id for idempotency
  UNIQUE (tenant_id, org_name, report_id)
);
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_tenant_date ON dmarc_aggregate_reports(tenant_id, date_range_end DESC);

CREATE TABLE IF NOT EXISTS dmarc_aggregate_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES dmarc_aggregate_reports(id) ON DELETE CASCADE,
  source_ip inet NOT NULL,
  count int NOT NULL,
  disposition text,                        -- none / quarantine / reject (actual)
  dkim_result text,                        -- pass / fail
  spf_result text,                         -- pass / fail
  header_from text,
  envelope_from text,
  envelope_to text
);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_report ON dmarc_aggregate_records(report_id);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_source_ip ON dmarc_aggregate_records(source_ip, count);

ALTER TABLE dmarc_aggregate_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_visible ON dmarc_aggregate_reports;
CREATE POLICY tenant_visible ON dmarc_aggregate_reports AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_visible_via_report ON dmarc_aggregate_records;
CREATE POLICY tenant_visible_via_report ON dmarc_aggregate_records AS PERMISSIVE FOR ALL TO postwave_app
  USING (EXISTS (SELECT 1 FROM dmarc_aggregate_reports r WHERE r.id = dmarc_aggregate_records.report_id AND r.tenant_id = current_setting('app.tenant_id', true)::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM dmarc_aggregate_reports r WHERE r.id = dmarc_aggregate_records.report_id AND r.tenant_id = current_setting('app.tenant_id', true)::uuid));
