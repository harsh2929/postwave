-- 1958_engagement_calibration_confidence_receipts.sql
--
-- Extends append-only F01 calibration receipts with the exact acceptance
-- policy and two-sided confidence bounds used for the release decision.
-- Existing v1 rows remain identifiable by a NULL report_schema_version; new
-- binaries write the v2 contract. No historical receipt is rewritten.
--
-- This is intentionally a phased additive migration so an older replica can
-- finish an in-flight v1 calibration during a rolling deployment. A later
-- cleanup migration may reject new v1 inserts after all replicas are proven
-- upgraded.
--
-- rollback-strategy: no-op. Revert readers/writers before a separately
-- reviewed cleanup migration removes additive columns.
-- migration-execution: phased

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.engagement_calibration_manifest_hashes_valid(input jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT jsonb_typeof(input) = 'array'
       AND jsonb_array_length(input) <= 32
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(input) AS item(value)
            WHERE jsonb_typeof(value) <> 'string'
               OR value #>> '{}' !~ '^[0-9a-f]{64}$'
       )
$fn$;

REVOKE ALL ON FUNCTION public.engagement_calibration_manifest_hashes_valid(jsonb)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.engagement_calibration_manifest_hashes_valid(jsonb)
    TO postwave_app;

ALTER TABLE engagement_classifier_calibration_reports
    ADD COLUMN report_schema_version text,
    ADD COLUMN correlated_human_corpus_manifest_hash text,
    ADD COLUMN machine_corpus_manifest_hashes jsonb,
    ADD COLUMN human_corpus_manifest_hashes jsonb,
    ADD COLUMN correlated_human_corpus_manifest_hashes jsonb,
    ADD COLUMN controlled_seed_sample_count bigint,
    ADD COLUMN report_payload jsonb,
    ADD COLUMN calibration_policy jsonb,
    ADD COLUMN confidence_level double precision,
    ADD COLUMN assumed_machine_prevalence double precision,
    ADD COLUMN prevalence_evidence_manifest_hash text,
    ADD COLUMN machine_recall_lower_bound numeric(9,8),
    ADD COLUMN machine_recall_upper_bound numeric(9,8),
    ADD COLUMN machine_precision_lower_bound numeric(9,8),
    ADD COLUMN machine_precision_upper_bound numeric(9,8),
    ADD COLUMN false_machine_positive_rate_lower_bound numeric(9,8),
    ADD COLUMN false_machine_positive_rate_upper_bound numeric(9,8),
    ADD COLUMN human_recall_lower_bound numeric(9,8),
    ADD COLUMN human_recall_upper_bound numeric(9,8),
    ADD COLUMN unknown_share_lower_bound numeric(9,8),
    ADD COLUMN unknown_share_upper_bound numeric(9,8);

ALTER TABLE engagement_classifier_calibration_reports
    ADD CONSTRAINT engagement_calibration_report_schema_v2_ck CHECK (
        report_schema_version IS NULL
        OR report_schema_version = 'postwave.engagement-calibration-report.v2'
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_correlated_manifest_hash_ck CHECK (
        correlated_human_corpus_manifest_hash IS NULL
        OR correlated_human_corpus_manifest_hash ~ '^[0-9a-f]{64}$'
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_manifest_lists_v2_ck CHECK (
        report_schema_version IS NULL
        OR (
            public.engagement_calibration_manifest_hashes_valid(machine_corpus_manifest_hashes)
            AND public.engagement_calibration_manifest_hashes_valid(human_corpus_manifest_hashes)
            AND public.engagement_calibration_manifest_hashes_valid(correlated_human_corpus_manifest_hashes)
            AND octet_length(machine_corpus_manifest_hashes::text) <= 4096
            AND octet_length(human_corpus_manifest_hashes::text) <= 4096
            AND octet_length(correlated_human_corpus_manifest_hashes::text) <= 4096
            AND controlled_seed_sample_count IS NOT NULL
            AND controlled_seed_sample_count >= 0
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_payload_v2_ck CHECK (
        report_schema_version IS NULL
        OR (
            jsonb_typeof(report_payload) = 'object'
            AND octet_length(report_payload::text) <= 262144
            AND report_payload ->> 'report_schema_version' = report_schema_version
            AND report_payload ->> 'report_fingerprint' = report_fingerprint
            AND report_payload ->> 'classifier_version' = classifier_version
            AND report_payload ->> 'methodology_version' = methodology_version
            AND report_payload ->> 'registry_version' = registry_version
            AND report_payload ->> 'configuration_hash' = configuration_hash
            AND report_payload ->> 'result' = result
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_policy_v2_ck CHECK (
        report_schema_version IS NULL
        OR (
            jsonb_typeof(calibration_policy) = 'object'
            AND octet_length(calibration_policy::text) <= 4096
            AND calibration_policy ?& ARRAY[
                'minimum_machine_samples',
                'minimum_human_samples',
                'minimum_machine_recall',
                'minimum_machine_precision',
                'maximum_false_machine_positive_rate',
                'confidence_level',
                'assumed_machine_prevalence',
                'prevalence_evidence_manifest_hash'
            ]
            AND calibration_policy - ARRAY[
                'minimum_machine_samples',
                'minimum_human_samples',
                'minimum_machine_recall',
                'minimum_machine_precision',
                'maximum_false_machine_positive_rate',
                'confidence_level',
                'assumed_machine_prevalence',
                'prevalence_evidence_manifest_hash'
            ] = '{}'::jsonb
            AND jsonb_typeof(calibration_policy -> 'minimum_machine_samples') = 'number'
            AND jsonb_typeof(calibration_policy -> 'minimum_human_samples') = 'number'
            AND jsonb_typeof(calibration_policy -> 'minimum_machine_recall') = 'number'
            AND jsonb_typeof(calibration_policy -> 'minimum_machine_precision') = 'number'
            AND jsonb_typeof(calibration_policy -> 'maximum_false_machine_positive_rate') = 'number'
            AND jsonb_typeof(calibration_policy -> 'confidence_level') = 'number'
            AND jsonb_typeof(calibration_policy -> 'assumed_machine_prevalence') = 'number'
            AND jsonb_typeof(calibration_policy -> 'prevalence_evidence_manifest_hash') = 'string'
            AND (calibration_policy ->> 'minimum_machine_samples')::numeric
                BETWEEN 1 AND 100000
            AND (calibration_policy ->> 'minimum_machine_samples')::numeric =
                trunc((calibration_policy ->> 'minimum_machine_samples')::numeric)
            AND (calibration_policy ->> 'minimum_human_samples')::numeric
                BETWEEN 1 AND 100000
            AND (calibration_policy ->> 'minimum_human_samples')::numeric =
                trunc((calibration_policy ->> 'minimum_human_samples')::numeric)
            AND (calibration_policy ->> 'minimum_machine_recall')::numeric
                BETWEEN 0 AND 1
            AND (calibration_policy ->> 'minimum_machine_precision')::numeric
                BETWEEN 0 AND 1
            AND (calibration_policy ->> 'maximum_false_machine_positive_rate')::numeric
                BETWEEN 0 AND 1
            AND (calibration_policy ->> 'confidence_level')::double precision = confidence_level
            AND (calibration_policy ->> 'assumed_machine_prevalence')::double precision =
                assumed_machine_prevalence
            AND calibration_policy ->> 'prevalence_evidence_manifest_hash' =
                prevalence_evidence_manifest_hash
            AND confidence_level BETWEEN 0.800000 AND 0.999000
            AND assumed_machine_prevalence > 0
            AND assumed_machine_prevalence < 1
            AND prevalence_evidence_manifest_hash ~ '^[0-9a-f]{64}$'
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_machine_recall_bounds_ck CHECK (
        (machine_recall_lower_bound IS NULL AND machine_recall_upper_bound IS NULL)
        OR (
            machine_recall_lower_bound BETWEEN 0 AND 1
            AND machine_recall_upper_bound BETWEEN machine_recall_lower_bound AND 1
            AND machine_recall BETWEEN machine_recall_lower_bound AND machine_recall_upper_bound
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_machine_precision_bounds_ck CHECK (
        (machine_precision_lower_bound IS NULL AND machine_precision_upper_bound IS NULL)
        OR (
            machine_precision_lower_bound BETWEEN 0 AND 1
            AND machine_precision_upper_bound BETWEEN machine_precision_lower_bound AND 1
            AND machine_precision BETWEEN machine_precision_lower_bound AND machine_precision_upper_bound
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_false_positive_bounds_ck CHECK (
        (
            false_machine_positive_rate_lower_bound IS NULL
            AND false_machine_positive_rate_upper_bound IS NULL
        )
        OR (
            false_machine_positive_rate_lower_bound BETWEEN 0 AND 1
            AND false_machine_positive_rate_upper_bound BETWEEN
                false_machine_positive_rate_lower_bound AND 1
            AND false_machine_positive_rate BETWEEN
                false_machine_positive_rate_lower_bound
                AND false_machine_positive_rate_upper_bound
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_human_recall_bounds_ck CHECK (
        (human_recall_lower_bound IS NULL AND human_recall_upper_bound IS NULL)
        OR (
            human_recall_lower_bound BETWEEN 0 AND 1
            AND human_recall_upper_bound BETWEEN human_recall_lower_bound AND 1
            AND human_recall BETWEEN human_recall_lower_bound AND human_recall_upper_bound
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_unknown_share_bounds_ck CHECK (
        (unknown_share_lower_bound IS NULL AND unknown_share_upper_bound IS NULL)
        OR (
            unknown_share_lower_bound BETWEEN 0 AND 1
            AND unknown_share_upper_bound BETWEEN unknown_share_lower_bound AND 1
            AND unknown_share BETWEEN unknown_share_lower_bound AND unknown_share_upper_bound
        )
    ) NOT VALID,
    ADD CONSTRAINT engagement_calibration_v2_interval_shape_ck CHECK (
        report_schema_version IS NULL
        OR (
            calibration_policy IS NOT NULL
            AND confidence_level IS NOT NULL
            AND assumed_machine_prevalence IS NOT NULL
            AND prevalence_evidence_manifest_hash IS NOT NULL
            AND (machine_sample_count = 0) = (machine_recall_lower_bound IS NULL)
            AND (machine_recall IS NULL) = (machine_recall_lower_bound IS NULL)
            AND (machine_recall_lower_bound IS NULL) = (machine_recall_upper_bound IS NULL)
            AND (machine_precision IS NULL) = (machine_precision_lower_bound IS NULL)
            AND (machine_precision_lower_bound IS NULL) = (machine_precision_upper_bound IS NULL)
            AND (human_sample_count = 0) = (false_machine_positive_rate_lower_bound IS NULL)
            AND (false_machine_positive_rate IS NULL) =
                (false_machine_positive_rate_lower_bound IS NULL)
            AND (false_machine_positive_rate_lower_bound IS NULL) =
                (false_machine_positive_rate_upper_bound IS NULL)
            AND (human_sample_count = 0) = (human_recall_lower_bound IS NULL)
            AND (human_recall IS NULL) = (human_recall_lower_bound IS NULL)
            AND (human_recall_lower_bound IS NULL) = (human_recall_upper_bound IS NULL)
            AND ((classified_sample_count + unknown_sample_count) = 0) =
                (unknown_share_lower_bound IS NULL)
            AND (unknown_share_lower_bound IS NULL) = (unknown_share_upper_bound IS NULL)
        )
    ) NOT VALID;

ALTER TABLE engagement_classifier_calibration_reports
    VALIDATE CONSTRAINT engagement_calibration_report_schema_v2_ck,
    VALIDATE CONSTRAINT engagement_calibration_correlated_manifest_hash_ck,
    VALIDATE CONSTRAINT engagement_calibration_manifest_lists_v2_ck,
    VALIDATE CONSTRAINT engagement_calibration_payload_v2_ck,
    VALIDATE CONSTRAINT engagement_calibration_policy_v2_ck,
    VALIDATE CONSTRAINT engagement_calibration_machine_recall_bounds_ck,
    VALIDATE CONSTRAINT engagement_calibration_machine_precision_bounds_ck,
    VALIDATE CONSTRAINT engagement_calibration_false_positive_bounds_ck,
    VALIDATE CONSTRAINT engagement_calibration_human_recall_bounds_ck,
    VALIDATE CONSTRAINT engagement_calibration_unknown_share_bounds_ck,
    VALIDATE CONSTRAINT engagement_calibration_v2_interval_shape_ck;

COMMENT ON COLUMN engagement_classifier_calibration_reports.report_schema_version
IS 'NULL for immutable legacy v1 receipts; postwave.engagement-calibration-report.v2 for confidence-aware receipts.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.calibration_policy
IS 'Exact bounded sample and Wilson-confidence acceptance policy used to derive result.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.correlated_human_corpus_manifest_hash
IS 'Combined exact-manifest hash for diagnostic conversion-correlated human corpora; never counted as labeled negatives.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.machine_corpus_manifest_hashes
IS 'Sorted inspectable exact-manifest commitments whose canonical JSON array hashes to machine_corpus_manifest_hash.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.human_corpus_manifest_hashes
IS 'Sorted inspectable exact-manifest commitments whose canonical JSON array hashes to human_corpus_manifest_hash.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.correlated_human_corpus_manifest_hashes
IS 'Sorted inspectable diagnostic-human exact-manifest commitments.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.controlled_seed_sample_count
IS 'Controlled-seed examples evaluated diagnostically but excluded from certifying machine recall because seed identity is an absolute classifier input.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.report_payload
IS 'Exact normalized v2 report used to verify immutable fingerprint replays; excludes generated row ID and recorded_at.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.confidence_level
IS 'Two-sided Wilson score confidence level shared by the persisted interval bounds.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.assumed_machine_prevalence
IS 'Reviewed deployment machine-event prevalence used to derive machine precision; never inferred from case-control corpus mix.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.prevalence_evidence_manifest_hash
IS 'SHA-256 of the governed population manifest supporting assumed_machine_prevalence.';
COMMENT ON COLUMN engagement_classifier_calibration_reports.machine_precision
IS 'Prevalence-adjusted positive predictive value derived from machine recall, false-machine-positive rate, and assumed_machine_prevalence.';

COMMIT;
