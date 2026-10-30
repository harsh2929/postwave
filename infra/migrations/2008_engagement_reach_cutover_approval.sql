-- 2008_engagement_reach_cutover_approval.sql
--
-- F12 may expose a human-engaged reach report only after two independent
-- durable facts exist:
--
--   1. an immutable F01 v2 calibration receipt passed the normative sample,
--      recall, precision, and false-positive gates; and
--   2. an operator completed the separate cutover review for that exact
--      classifier/methodology/registry/configuration identity.
--
-- This table records only the second fact and binds it by a composite foreign
-- key to the first. The application role has SELECT only: an API process must
-- never be able to approve its own classifier release. No approval is seeded
-- by this migration, so deploying it leaves F12 fail-closed.
--
-- rollback-strategy: no-op. Revert the reader before a separately reviewed
-- migration removes this append-only release evidence.
-- migration-execution: transactional

BEGIN;

SET LOCAL lock_timeout = '5s';

-- PostgreSQL requires one exact unique key for the version-bound composite
-- foreign key below. `id` is already unique, but including every identity
-- field makes database-level relabelling impossible even for an operator
-- writing the approval receipt directly.
ALTER TABLE engagement_classifier_calibration_reports
    ADD CONSTRAINT engagement_calibration_reports_cutover_identity_uniq
    UNIQUE (
        id,
        classifier_version,
        methodology_version,
        registry_version,
        configuration_hash,
        report_fingerprint
    );

CREATE TABLE engagement_classifier_reach_cutover_approvals (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_schema_version       text NOT NULL CHECK (
                                      approval_schema_version =
                                      'postwave.engagement-reach-cutover-approval.v1'
                                  ),
    calibration_report_id         uuid NOT NULL,
    calibration_report_fingerprint text NOT NULL CHECK (
                                      calibration_report_fingerprint ~ '^[0-9a-f]{64}$'
                                  ),
    classifier_version            text NOT NULL CHECK (
                                      classifier_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                                  ),
    methodology_version           text NOT NULL CHECK (
                                      methodology_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                                  ),
    registry_version              text NOT NULL CHECK (
                                      registry_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                                  ),
    configuration_hash            text NOT NULL CHECK (
                                      configuration_hash ~ '^[0-9a-f]{64}$'
                                  ),
    approved_by                   text NOT NULL CHECK (
                                      approved_by = btrim(approved_by)
                                      AND length(approved_by) BETWEEN 3 AND 200
                                      AND approved_by !~ '[[:cntrl:]]'
                                  ),
    approval_reason               text NOT NULL CHECK (
                                      approval_reason = btrim(approval_reason)
                                      AND length(approval_reason) BETWEEN 10 AND 4000
                                      AND approval_reason !~ '[[:cntrl:]]'
                                  ),
    review_evidence_sha256        text NOT NULL CHECK (
                                      review_evidence_sha256 ~ '^[0-9a-f]{64}$'
                                  ),
    approved_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT engagement_reach_cutover_calibration_identity_fk
        FOREIGN KEY (
            calibration_report_id,
            classifier_version,
            methodology_version,
            registry_version,
            configuration_hash,
            calibration_report_fingerprint
        ) REFERENCES engagement_classifier_calibration_reports (
            id,
            classifier_version,
            methodology_version,
            registry_version,
            configuration_hash,
            report_fingerprint
        ) ON DELETE RESTRICT,
    UNIQUE (calibration_report_id),
    UNIQUE (review_evidence_sha256)
);

COMMENT ON TABLE engagement_classifier_reach_cutover_approvals IS
    'Append-only operator approval for F12, bound to one passing immutable F01 calibration receipt and exact classifier identity. No row means human-engaged reach is unavailable.';
COMMENT ON COLUMN engagement_classifier_reach_cutover_approvals.review_evidence_sha256 IS
    'SHA-256 commitment to the separately reviewed cutover record; the approval row is not itself a substitute for that review.';

CREATE TRIGGER engagement_classifier_reach_cutover_approvals_append_only
    BEFORE UPDATE OR DELETE ON engagement_classifier_reach_cutover_approvals
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();

REVOKE ALL ON engagement_classifier_reach_cutover_approvals FROM PUBLIC;
GRANT SELECT ON engagement_classifier_reach_cutover_approvals TO postwave_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
    ON engagement_classifier_reach_cutover_approvals FROM postwave_app;

ALTER TABLE engagement_classifier_reach_cutover_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_classifier_reach_cutover_approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY engagement_reach_cutover_worker_select
    ON engagement_classifier_reach_cutover_approvals
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

COMMIT;
