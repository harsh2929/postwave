-- 1854_dmarc_evidence_hardening.sql
--
-- Make the customer-facing DMARC evidence boundary deterministic and repair
-- unsafe DNS instructions emitted by the former sending-identity wizard.
-- Every safely repairable aggregate field is reconciled before its NOT VALID
-- check is validated; new writes are constrained from the first phase onward.
-- Historical non-positive record counts are intentionally preserved as audit
-- evidence and remain excluded by the application read paths (`count > 0`).
-- Their write-time check stays NOT VALID until a separately reviewed,
-- resumable evidence-retention job resolves those rows without schema-time
-- deletion.
--
-- This migration deliberately does NOT qualify or enable an inbound report
-- transport. Legacy IMAP ingestion remains production-disabled until an
-- authenticated recipient transport, tenant-bound opaque addresses, external
-- reporting authorization, abuse controls, and privacy lifecycle are proven
-- end to end.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the canonicalized evidence, safe DNS instructions,
-- validated checks, FORCE RLS, and online indexes. Older readers accept the
-- narrowed rows. Reintroducing rua/ruf destinations requires a separately
-- reviewed transport and authorization rollout, never a rollback.

-- Phase 1: establish fail-closed write contracts under short DDL lock budgets.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE dmarc_aggregate_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_records FORCE ROW LEVEL SECURITY;

ALTER TABLE dmarc_aggregate_reports
    DROP CONSTRAINT IF EXISTS dmarc_reports_date_order_check,
    DROP CONSTRAINT IF EXISTS dmarc_reports_org_name_bounds_check,
    DROP CONSTRAINT IF EXISTS dmarc_reports_report_id_bounds_check,
    DROP CONSTRAINT IF EXISTS dmarc_reports_domain_bounds_check,
    DROP CONSTRAINT IF EXISTS dmarc_reports_policy_p_check,
    DROP CONSTRAINT IF EXISTS dmarc_reports_policy_sp_check,
    DROP CONSTRAINT IF EXISTS dmarc_reports_legacy_policy_pct_check;

ALTER TABLE dmarc_aggregate_reports
    ADD CONSTRAINT dmarc_reports_date_order_check
        CHECK (date_range_end >= date_range_begin) NOT VALID,
    ADD CONSTRAINT dmarc_reports_org_name_bounds_check
        CHECK (
            char_length(btrim(org_name)) BETWEEN 1 AND 256
            AND org_name !~ '[[:cntrl:]]'
        ) NOT VALID,
    ADD CONSTRAINT dmarc_reports_report_id_bounds_check
        CHECK (
            char_length(btrim(report_id)) BETWEEN 1 AND 512
            AND report_id !~ '[[:cntrl:]]'
        ) NOT VALID,
    ADD CONSTRAINT dmarc_reports_domain_bounds_check
        CHECK (
            domain = btrim(domain)
            AND char_length(domain) BETWEEN 1 AND 253
            AND lower(domain) ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
            AND lower(domain) !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
        ) NOT VALID,
    ADD CONSTRAINT dmarc_reports_policy_p_check
        CHECK (policy_p IS NULL OR lower(btrim(policy_p)) IN ('none', 'quarantine', 'reject', 'unknown')) NOT VALID,
    ADD CONSTRAINT dmarc_reports_policy_sp_check
        CHECK (policy_sp IS NULL OR lower(btrim(policy_sp)) IN ('none', 'quarantine', 'reject', 'unknown')) NOT VALID,
    ADD CONSTRAINT dmarc_reports_legacy_policy_pct_check
        CHECK (policy_pct IS NULL OR policy_pct BETWEEN 0 AND 100) NOT VALID;

ALTER TABLE dmarc_aggregate_records
    DROP CONSTRAINT IF EXISTS dmarc_records_positive_count_check,
    DROP CONSTRAINT IF EXISTS dmarc_records_disposition_check,
    DROP CONSTRAINT IF EXISTS dmarc_records_header_from_bounds_check,
    DROP CONSTRAINT IF EXISTS dmarc_records_envelope_from_bounds_check,
    DROP CONSTRAINT IF EXISTS dmarc_records_envelope_to_bounds_check;

ALTER TABLE dmarc_aggregate_records
    ADD CONSTRAINT dmarc_records_positive_count_check
        CHECK (count > 0) NOT VALID,
    ADD CONSTRAINT dmarc_records_disposition_check
        CHECK (disposition IS NULL OR lower(btrim(disposition)) IN ('none', 'quarantine', 'reject', 'unknown')) NOT VALID,
    ADD CONSTRAINT dmarc_records_header_from_bounds_check
        CHECK (
            header_from IS NULL
            OR (
                char_length(header_from) BETWEEN 1 AND 253
                AND header_from !~ '[[:cntrl:]]'
            )
        ) NOT VALID,
    ADD CONSTRAINT dmarc_records_envelope_from_bounds_check
        CHECK (
            envelope_from IS NULL
            OR (
                char_length(envelope_from) BETWEEN 1 AND 320
                AND envelope_from !~ '[[:cntrl:]]'
            )
        ) NOT VALID,
    ADD CONSTRAINT dmarc_records_envelope_to_bounds_check
        CHECK (
            envelope_to IS NULL
            OR (
                char_length(envelope_to) BETWEEN 1 AND 320
                AND envelope_to !~ '[[:cntrl:]]'
            )
        ) NOT VALID;

ALTER TABLE sending_identities
    DROP CONSTRAINT IF EXISTS sending_identities_dns_instruction_safety_check;

-- These columns are wizard instructions, not a tenant-owned live-DNS policy.
-- Pinning them prevents an old application replica from persisting the former
-- unqualified Postwave rua/ruf destinations during a rolling deployment.
ALTER TABLE sending_identities
    ADD CONSTRAINT sending_identities_dns_instruction_safety_check
    CHECK (
        spf_record_value IS NOT NULL
        AND dmarc_record_value IS NOT NULL
        AND spf_record_value = 'v=spf1 include:_spf.postwave.io -all'
        AND dmarc_record_value = 'v=DMARC1; p=none; aspf=r; adkim=r'
    ) NOT VALID;

COMMIT;

-- Phase 2: reconcile historical rows inside a bounded, atomic data phase.
-- Invalid aggregate identities receive an explicit UUID-suffixed placeholder
-- rather than being silently merged or discarded. The canonical production
-- migrator is the privileged schema owner. These tables already use FORCE RLS,
-- so relax FORCE only inside this transaction; ENABLE remains in force for the
-- runtime role, and transactional DDL restores FORCE atomically at commit.
-- `row_security = off` does not grant a bypass: it makes an incorrectly scoped
-- migrator fail instead of silently reconciling zero visible rows.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE sending_identities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_records NO FORCE ROW LEVEL SECURITY;
SET LOCAL row_security = off;

UPDATE sending_identities
   SET spf_record_value = 'v=spf1 include:_spf.postwave.io -all',
       dmarc_record_value = 'v=DMARC1; p=none; aspf=r; adkim=r',
       spf_verified_at = CASE
           WHEN spf_record_value = 'v=spf1 include:_spf.postwave.io -all'
               THEN spf_verified_at
           ELSE NULL
       END,
       dmarc_verified_at = CASE
           WHEN dmarc_record_value = 'v=DMARC1; p=none; aspf=r; adkim=r'
               THEN dmarc_verified_at
           ELSE NULL
       END,
       verify_state = CASE
           WHEN dkim_verified_at IS NOT NULL
             OR (
                 spf_record_value = 'v=spf1 include:_spf.postwave.io -all'
                 AND spf_verified_at IS NOT NULL
             )
             OR (
                 dmarc_record_value = 'v=DMARC1; p=none; aspf=r; adkim=r'
                 AND dmarc_verified_at IS NOT NULL
             )
               THEN 'partial'
           ELSE 'pending'
       END,
       verified_at = NULL,
       last_verify_attempt_at = NULL,
       last_verify_error = NULL,
       updated_at = now()
 WHERE spf_record_value IS DISTINCT FROM 'v=spf1 include:_spf.postwave.io -all'
    OR dmarc_record_value IS DISTINCT FROM 'v=DMARC1; p=none; aspf=r; adkim=r';

WITH prepared AS (
    SELECT
        id,
        org_name AS original_org_name,
        report_id AS original_report_id,
        btrim(regexp_replace(org_name, '[[:cntrl:]]', '', 'g')) AS clean_org_name,
        btrim(regexp_replace(report_id, '[[:cntrl:]]', '', 'g')) AS clean_report_id,
        lower(btrim(regexp_replace(domain, '[[:cntrl:]]', '', 'g'))) AS clean_domain
      FROM dmarc_aggregate_reports
), reconciled AS (
    SELECT
        id,
        CASE
            WHEN clean_org_name <> ''
             AND char_length(clean_org_name) <= 256
             AND clean_org_name = original_org_name
                THEN clean_org_name
            ELSE left(COALESCE(NULLIF(clean_org_name, ''), 'Unknown reporter'), 219)
                 || '~' || id::text
        END AS org_name,
        CASE
            WHEN clean_report_id <> ''
             AND char_length(clean_report_id) <= 512
             AND clean_report_id = original_report_id
                THEN clean_report_id
            ELSE left(COALESCE(NULLIF(clean_report_id, ''), 'Unknown report'), 475)
                 || '~' || id::text
        END AS report_id,
        CASE
            WHEN char_length(clean_domain) BETWEEN 1 AND 253
             AND clean_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
             AND clean_domain !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
                THEN clean_domain
            ELSE 'invalid-' || id::text || '.invalid'
        END AS domain
      FROM prepared
)
UPDATE dmarc_aggregate_reports AS report
   SET org_name = reconciled.org_name,
       report_id = reconciled.report_id,
       domain = reconciled.domain,
       date_range_begin = LEAST(report.date_range_begin, report.date_range_end),
       date_range_end = GREATEST(report.date_range_begin, report.date_range_end),
       policy_p = CASE lower(btrim(COALESCE(report.policy_p, '')))
           WHEN '' THEN NULL
           WHEN 'none' THEN 'none'
           WHEN 'quarantine' THEN 'quarantine'
           WHEN 'reject' THEN 'reject'
           WHEN 'unknown' THEN 'unknown'
           ELSE 'unknown'
       END,
       policy_sp = CASE lower(btrim(COALESCE(report.policy_sp, '')))
           WHEN '' THEN NULL
           WHEN 'none' THEN 'none'
           WHEN 'quarantine' THEN 'quarantine'
           WHEN 'reject' THEN 'reject'
           WHEN 'unknown' THEN 'unknown'
           ELSE 'unknown'
       END,
       policy_pct = CASE WHEN report.policy_pct BETWEEN 0 AND 100 THEN report.policy_pct ELSE NULL END
  FROM reconciled
 WHERE report.id = reconciled.id
   AND (
       report.org_name IS DISTINCT FROM reconciled.org_name
       OR report.report_id IS DISTINCT FROM reconciled.report_id
       OR report.domain IS DISTINCT FROM reconciled.domain
       OR report.date_range_begin > report.date_range_end
       OR report.policy_p IS DISTINCT FROM CASE lower(btrim(COALESCE(report.policy_p, '')))
           WHEN '' THEN NULL WHEN 'none' THEN 'none' WHEN 'quarantine' THEN 'quarantine'
           WHEN 'reject' THEN 'reject' WHEN 'unknown' THEN 'unknown' ELSE 'unknown' END
       OR report.policy_sp IS DISTINCT FROM CASE lower(btrim(COALESCE(report.policy_sp, '')))
           WHEN '' THEN NULL WHEN 'none' THEN 'none' WHEN 'quarantine' THEN 'quarantine'
           WHEN 'reject' THEN 'reject' WHEN 'unknown' THEN 'unknown' ELSE 'unknown' END
       OR report.policy_pct IS DISTINCT FROM CASE
           WHEN report.policy_pct BETWEEN 0 AND 100 THEN report.policy_pct ELSE NULL END
   );

WITH reconciled AS (
    SELECT
        id,
        CASE lower(btrim(COALESCE(disposition, '')))
            WHEN '' THEN NULL
            WHEN 'none' THEN 'none'
            WHEN 'quarantine' THEN 'quarantine'
            WHEN 'reject' THEN 'reject'
            WHEN 'unknown' THEN 'unknown'
            ELSE 'unknown'
        END AS disposition,
        NULLIF(left(btrim(regexp_replace(COALESCE(header_from, ''), '[[:cntrl:]]', '', 'g')), 253), '') AS header_from,
        NULLIF(left(btrim(regexp_replace(COALESCE(envelope_from, ''), '[[:cntrl:]]', '', 'g')), 320), '') AS envelope_from,
        NULLIF(left(btrim(regexp_replace(COALESCE(envelope_to, ''), '[[:cntrl:]]', '', 'g')), 320), '') AS envelope_to
      FROM dmarc_aggregate_records
)
UPDATE dmarc_aggregate_records AS record
   SET disposition = reconciled.disposition,
       header_from = reconciled.header_from,
       envelope_from = reconciled.envelope_from,
       envelope_to = reconciled.envelope_to
  FROM reconciled
 WHERE record.id = reconciled.id
   AND (
       record.disposition IS DISTINCT FROM reconciled.disposition
       OR record.header_from IS DISTINCT FROM reconciled.header_from
       OR record.envelope_from IS DISTINCT FROM reconciled.envelope_from
       OR record.envelope_to IS DISTINCT FROM reconciled.envelope_to
   );

ALTER TABLE sending_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_records FORCE ROW LEVEL SECURITY;

COMMIT;

-- Phase 3: NOT VALID already protected new writes; validation now attests the
-- reconciled historical set under a weaker lock than the add phase.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_date_order_check;
ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_org_name_bounds_check;
ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_report_id_bounds_check;
ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_domain_bounds_check;
ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_policy_p_check;
ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_policy_sp_check;
ALTER TABLE dmarc_aggregate_reports
    VALIDATE CONSTRAINT dmarc_reports_legacy_policy_pct_check;

-- Deliberately not validated yet: legacy non-positive evidence is preserved,
-- while NOT VALID still rejects every invalid INSERT/UPDATE from this deploy
-- forward. Insights and report listings already require `rec.count > 0`.
ALTER TABLE dmarc_aggregate_records
    VALIDATE CONSTRAINT dmarc_records_disposition_check;
ALTER TABLE dmarc_aggregate_records
    VALIDATE CONSTRAINT dmarc_records_header_from_bounds_check;
ALTER TABLE dmarc_aggregate_records
    VALIDATE CONSTRAINT dmarc_records_envelope_from_bounds_check;
ALTER TABLE dmarc_aggregate_records
    VALIDATE CONSTRAINT dmarc_records_envelope_to_bounds_check;

ALTER TABLE sending_identities
    VALIDATE CONSTRAINT sending_identities_dns_instruction_safety_check;

COMMIT;

-- Phase 4: both read paths operate on established tables, so their indexes
-- are built online and outside every explicit transaction.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmarc_reports_tenant_domain_period
    ON dmarc_aggregate_reports (tenant_id, lower(domain), date_range_end DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmarc_records_report_source
    ON dmarc_aggregate_records (report_id, source_ip);

RESET statement_timeout;
RESET lock_timeout;
