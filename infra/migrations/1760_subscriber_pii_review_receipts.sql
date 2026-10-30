-- SUB-071 / P1-14 — immutable, tenant-bound shadow-PII review receipts.
-- migration-execution: phased
--
-- Findings historically stored only a mutable status/reviewer pair. That was
-- insufficient compliance evidence: a second review could overwrite the first,
-- the outcome had no rationale/evidence, and detector/policy versions were not
-- preserved. This migration adds immutable detection metadata, a one-to-one
-- receipt, structural tenant FKs, and database guards around the lifecycle.
--
-- New evidence is a tenant-separated, domain-separated HMAC-SHA256 fingerprint
-- under an application-only dedicated pepper. Historical bare SHA-256 values
-- cannot be safely re-keyed without cleartext, so this migration destroys them
-- and substitutes random legacy-redacted tokens while preserving
-- finding/receipt equality. Legacy reviewer labels are likewise replaced with
-- random non-recomputable actor tokens.
-- rollback-strategy: no-op — retain compliance receipts. Pre-1760 scanner
-- inserts intentionally fail their best-effort hook because they cannot supply
-- keyed-fingerprint provenance; other subscriber writes remain available.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_tenant_id_id_uniq
    ON subscriber_pii_findings (tenant_id, id);

BEGIN;

ALTER TABLE subscriber_pii_findings
    -- No pre-1760 row persisted this provenance. Keep the columns nullable
    -- until the honest legacy/unknown labels below are assigned; defaulting to
    -- the current detector would retroactively invent compliance evidence.
    ADD COLUMN IF NOT EXISTS scanner_name text,
    ADD COLUMN IF NOT EXISTS scanner_version text,
    ADD COLUMN IF NOT EXISTS detector_name text,
    ADD COLUMN IF NOT EXISTS detector_version text,
    ADD COLUMN IF NOT EXISTS policy_name text,
    ADD COLUMN IF NOT EXISTS policy_version text,
    -- Intentionally no defaults: a pre-1760 binary cannot silently insert a
    -- bare SHA-256 value or fabricated current provenance.
    ADD COLUMN IF NOT EXISTS fingerprint_scheme text,
    ADD COLUMN IF NOT EXISTS fingerprint_key_version text;

-- Bare SHA-256 is enumerable for SSNs/phones/cards. It cannot be transformed
-- into a keyed fingerprint without the original match, which was correctly
-- never stored. Destroy the old token and retain only random linkage evidence.
UPDATE subscriber_pii_findings
   SET raw_value_hash = encode(gen_random_bytes(32), 'hex'),
       fingerprint_scheme = 'legacy-redacted-v1',
       fingerprint_key_version = 'legacy',
       scanner_name = 'legacy-unversioned',
       scanner_version = 'unknown-pre-1760',
       detector_name = 'legacy-unversioned',
       detector_version = 'unknown-pre-1760',
       policy_name = 'legacy-unversioned',
       policy_version = 'unknown-pre-1760'
 WHERE fingerprint_scheme IS NULL
    OR fingerprint_key_version IS NULL;

ALTER TABLE subscriber_pii_findings
    ALTER COLUMN scanner_name SET NOT NULL,
    ALTER COLUMN scanner_version SET NOT NULL,
    ALTER COLUMN detector_name SET NOT NULL,
    ALTER COLUMN detector_version SET NOT NULL,
    ALTER COLUMN policy_name SET NOT NULL,
    ALTER COLUMN policy_version SET NOT NULL,
    ALTER COLUMN fingerprint_scheme SET NOT NULL,
    ALTER COLUMN fingerprint_key_version SET NOT NULL;

ALTER TABLE subscriber_pii_findings
    ADD CONSTRAINT subscriber_pii_findings_fingerprint_token_check
        CHECK (raw_value_hash ~ '^[0-9a-f]{64}$') NOT VALID,
    ADD CONSTRAINT subscriber_pii_findings_detection_metadata_check CHECK (
        char_length(btrim(scanner_name)) BETWEEN 1 AND 128
        AND char_length(btrim(scanner_version)) BETWEEN 1 AND 128
        AND char_length(btrim(detector_name)) BETWEEN 1 AND 128
        AND char_length(btrim(detector_version)) BETWEEN 1 AND 128
        AND char_length(btrim(policy_name)) BETWEEN 1 AND 128
        AND char_length(btrim(policy_version)) BETWEEN 1 AND 128
        AND (
            (fingerprint_scheme = 'legacy-redacted-v1'
             AND fingerprint_key_version = 'legacy'
             AND scanner_name = 'legacy-unversioned'
             AND scanner_version = 'unknown-pre-1760'
             AND detector_name = 'legacy-unversioned'
             AND detector_version = 'unknown-pre-1760'
             AND policy_name = 'legacy-unversioned'
             AND policy_version = 'unknown-pre-1760')
            OR
            (fingerprint_scheme = 'hmac-sha256-v1'
             AND fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
             AND fingerprint_key_version <> 'legacy')
        )
    ) NOT VALID;

ALTER TABLE subscriber_pii_findings
    VALIDATE CONSTRAINT subscriber_pii_findings_fingerprint_token_check;
ALTER TABLE subscriber_pii_findings
    VALIDATE CONSTRAINT subscriber_pii_findings_detection_metadata_check;

-- A schedule was previously accepted by the API but no scheduled worker exists.
-- Clear that inert state so the control plane cannot imply work is occurring.
UPDATE tenant_pii_scan_config
   SET scan_schedule = NULL
 WHERE scan_schedule IS NOT NULL;

ALTER TABLE subscriber_pii_findings
    DROP CONSTRAINT IF EXISTS subscriber_pii_findings_subscriber_id_fkey;

ALTER TABLE subscriber_pii_findings
    ADD CONSTRAINT subscriber_pii_findings_tenant_subscriber_fkey
    FOREIGN KEY (tenant_id, subscriber_id)
    REFERENCES subscribers (tenant_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE subscriber_pii_findings
    VALIDATE CONSTRAINT subscriber_pii_findings_tenant_subscriber_fkey;

CREATE TABLE IF NOT EXISTS subscriber_pii_review_receipts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    finding_id          uuid NOT NULL,
    status              text NOT NULL CHECK (status IN ('reviewed', 'dismissed')),
    reason              text NOT NULL,
    review_comment      text NOT NULL CHECK (
                            char_length(btrim(review_comment)) BETWEEN 1 AND 2000
                        ),
    evidence_reference  text NOT NULL CHECK (
                            char_length(btrim(evidence_reference)) BETWEEN 3 AND 288
                            AND evidence_reference ~ '^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$'
                        ),
    actor_type          text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'legacy')),
    actor_id            text NOT NULL CHECK (
                            (actor_type = 'legacy' AND actor_id ~ '^[0-9a-f]{64}$')
                            OR
                            (actor_type IN ('user', 'api_key') AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                        ),
    reviewed_at         timestamptz NOT NULL DEFAULT now(),
    scanner_name        text NOT NULL CHECK (char_length(btrim(scanner_name)) BETWEEN 1 AND 128),
    scanner_version     text NOT NULL CHECK (char_length(btrim(scanner_version)) BETWEEN 1 AND 128),
    detector_name       text NOT NULL CHECK (char_length(btrim(detector_name)) BETWEEN 1 AND 128),
    detector_version    text NOT NULL CHECK (char_length(btrim(detector_version)) BETWEEN 1 AND 128),
    policy_name         text NOT NULL CHECK (char_length(btrim(policy_name)) BETWEEN 1 AND 128),
    policy_version      text NOT NULL CHECK (char_length(btrim(policy_version)) BETWEEN 1 AND 128),
    raw_value_hash      text NOT NULL CHECK (raw_value_hash ~ '^[0-9a-f]{64}$'),
    fingerprint_scheme  text NOT NULL,
    fingerprint_key_version text NOT NULL,
    finding_updated_at  timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscriber_pii_review_receipts_reason_check CHECK (
        (actor_type = 'legacy' AND reason = 'legacy_migrated')
        OR
        (actor_type IN ('user', 'api_key') AND (
            (status = 'reviewed' AND reason IN ('confirmed_pii', 'remediated', 'accepted_risk'))
            OR
            (status = 'dismissed' AND reason IN ('false_positive', 'duplicate', 'test_data', 'not_personal_data'))
        ))
    ),
    CONSTRAINT subscriber_pii_review_receipts_fingerprint_provenance_check CHECK (
        (fingerprint_scheme = 'legacy-redacted-v1'
         AND fingerprint_key_version = 'legacy'
         AND scanner_name = 'legacy-unversioned'
         AND scanner_version = 'unknown-pre-1760'
         AND detector_name = 'legacy-unversioned'
         AND detector_version = 'unknown-pre-1760'
         AND policy_name = 'legacy-unversioned'
         AND policy_version = 'unknown-pre-1760')
        OR
        (fingerprint_scheme = 'hmac-sha256-v1'
         AND fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
         AND fingerprint_key_version <> 'legacy')
    ),
    CONSTRAINT subscriber_pii_review_receipts_comment_no_raw_pii_check CHECK (
        review_comment !~* '\m[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\M'
        AND review_comment !~ '\m[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}\M'
        AND review_comment !~ '\m[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\M'
        AND review_comment !~ '\m([0-9]{1,3}\.){3}[0-9]{1,3}\M'
        AND review_comment !~* '\m[0-9A-F]{1,4}(:[0-9A-F]{0,4}){2,7}\M'
        AND review_comment !~ '\m([0-9][ -]?){12,18}[0-9]\M'
    ),
    CONSTRAINT subscriber_pii_review_receipts_finding_fk
        FOREIGN KEY (tenant_id, finding_id)
        REFERENCES subscriber_pii_findings (tenant_id, id)
        ON DELETE CASCADE,
    UNIQUE (tenant_id, finding_id)
);

COMMENT ON TABLE subscriber_pii_review_receipts IS
    'Immutable SUB-071 DPO decision receipts. Contains versioned keyed fingerprints or random legacy-redacted linkage tokens, never detected cleartext or enumerable bare hashes.';

-- Convert pre-1760 terminal rows into explicit immutable evidence without
-- inventing a human-authored rationale. The legacy reviewer label is discarded
-- and replaced with a random token so even a predictable email label cannot be
-- recovered by dictionary enumeration.
INSERT INTO subscriber_pii_review_receipts (
    tenant_id, finding_id, status, reason, review_comment,
    evidence_reference, actor_type, actor_id, reviewed_at,
    scanner_name, scanner_version, detector_name, detector_version,
    policy_name, policy_version, raw_value_hash, fingerprint_scheme,
    fingerprint_key_version, finding_updated_at
)
SELECT f.tenant_id,
       f.id,
       f.status,
       'legacy_migrated',
       'Legacy terminal decision migrated without an originally captured rationale.',
       'migration:1760',
       'legacy',
       encode(gen_random_bytes(32), 'hex'),
       COALESCE(f.reviewed_at, f.updated_at, f.created_at),
       f.scanner_name, f.scanner_version, f.detector_name, f.detector_version,
       f.policy_name, f.policy_version, f.raw_value_hash,
       f.fingerprint_scheme, f.fingerprint_key_version, f.updated_at
  FROM subscriber_pii_findings f
 WHERE f.status IN ('reviewed', 'dismissed')
ON CONFLICT (tenant_id, finding_id) DO NOTHING;

-- Old application versions did not enforce the pending/null pairing. Repair
-- any stale reviewer stamps before validating the new lifecycle constraint.
UPDATE subscriber_pii_findings
   SET reviewed_at = NULL,
       reviewed_by = NULL
 WHERE status = 'pending'
   AND (reviewed_at IS NOT NULL OR reviewed_by IS NOT NULL);

UPDATE subscriber_pii_findings f
   SET reviewed_at = r.reviewed_at,
       reviewed_by = r.actor_type || ':' || r.actor_id
  FROM subscriber_pii_review_receipts r
 WHERE r.tenant_id = f.tenant_id
   AND r.finding_id = f.id
   AND f.status IN ('reviewed', 'dismissed');

ALTER TABLE subscriber_pii_findings
    ADD CONSTRAINT subscriber_pii_findings_review_state_check CHECK (
        (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
        OR
        (status IN ('reviewed', 'dismissed') AND reviewed_at IS NOT NULL AND NULLIF(btrim(reviewed_by), '') IS NOT NULL)
    ) NOT VALID;

ALTER TABLE subscriber_pii_findings
    VALIDATE CONSTRAINT subscriber_pii_findings_review_state_check;

CREATE OR REPLACE FUNCTION guard_subscriber_pii_finding_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    receipt subscriber_pii_review_receipts%ROWTYPE;
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id
       OR NEW.field_name IS DISTINCT FROM OLD.field_name
       OR NEW.detected_type IS DISTINCT FROM OLD.detected_type
       OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.raw_value_hash IS DISTINCT FROM OLD.raw_value_hash
       OR NEW.fingerprint_scheme IS DISTINCT FROM OLD.fingerprint_scheme
       OR NEW.fingerprint_key_version IS DISTINCT FROM OLD.fingerprint_key_version
       OR NEW.scanner_name IS DISTINCT FROM OLD.scanner_name
       OR NEW.scanner_version IS DISTINCT FROM OLD.scanner_version
       OR NEW.detector_name IS DISTINCT FROM OLD.detector_name
       OR NEW.detector_version IS DISTINCT FROM OLD.detector_version
       OR NEW.policy_name IS DISTINCT FROM OLD.policy_name
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'PII finding identity and detection metadata are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('reviewed', 'dismissed') AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
        OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
        OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
    ) THEN
        RAISE EXCEPTION 'PII finding has an immutable terminal review receipt'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'pending' AND NEW.status IN ('reviewed', 'dismissed') THEN
        SELECT * INTO receipt
          FROM subscriber_pii_review_receipts
         WHERE tenant_id = OLD.tenant_id AND finding_id = OLD.id;
        IF NOT FOUND
           OR receipt.status <> NEW.status
           OR receipt.reviewed_at IS DISTINCT FROM NEW.reviewed_at
           OR receipt.actor_type || ':' || receipt.actor_id <> NEW.reviewed_by THEN
            RAISE EXCEPTION 'terminal PII finding state requires its matching immutable receipt'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'invalid PII finding review transition'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriber_pii_findings_review_guard ON subscriber_pii_findings;
DROP TRIGGER IF EXISTS subscriber_pii_findings_zz_review_guard ON subscriber_pii_findings;
-- The zz prefix makes this run after subscriber_pii_findings_set_updated_at,
-- so even an otherwise no-op UPDATE cannot mutate a terminal updated_at.
CREATE TRIGGER subscriber_pii_findings_zz_review_guard
    BEFORE UPDATE ON subscriber_pii_findings
    FOR EACH ROW EXECUTE FUNCTION guard_subscriber_pii_finding_review();

CREATE OR REPLACE FUNCTION enforce_subscriber_pii_review_receipt_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    finding_status text;
    finding_reviewed_at timestamptz;
    finding_reviewed_by text;
    finding_scanner_name text;
    finding_scanner_version text;
    finding_detector_name text;
    finding_detector_version text;
    finding_policy_name text;
    finding_policy_version text;
    finding_fingerprint text;
    finding_fingerprint_scheme text;
    finding_fingerprint_key_version text;
BEGIN
    SELECT status, reviewed_at, reviewed_by,
           scanner_name, scanner_version, detector_name, detector_version,
           policy_name, policy_version, raw_value_hash,
           fingerprint_scheme, fingerprint_key_version
      INTO finding_status, finding_reviewed_at, finding_reviewed_by,
           finding_scanner_name, finding_scanner_version,
           finding_detector_name, finding_detector_version,
           finding_policy_name, finding_policy_version, finding_fingerprint,
           finding_fingerprint_scheme, finding_fingerprint_key_version
      FROM subscriber_pii_findings
     WHERE tenant_id = NEW.tenant_id AND id = NEW.finding_id;

    IF NOT FOUND
       OR finding_status <> NEW.status
       OR finding_reviewed_at IS DISTINCT FROM NEW.reviewed_at
       OR finding_reviewed_by <> (NEW.actor_type || ':' || NEW.actor_id)
       OR finding_scanner_name <> NEW.scanner_name
       OR finding_scanner_version <> NEW.scanner_version
       OR finding_detector_name <> NEW.detector_name
       OR finding_detector_version <> NEW.detector_version
       OR finding_policy_name <> NEW.policy_name
       OR finding_policy_version <> NEW.policy_version
       OR finding_fingerprint <> NEW.raw_value_hash
       OR finding_fingerprint_scheme <> NEW.fingerprint_scheme
       OR finding_fingerprint_key_version <> NEW.fingerprint_key_version THEN
        RAISE EXCEPTION 'PII review receipt must match its terminal finding state'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriber_pii_review_receipts_link_guard ON subscriber_pii_review_receipts;
CREATE CONSTRAINT TRIGGER subscriber_pii_review_receipts_link_guard
    AFTER INSERT ON subscriber_pii_review_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_subscriber_pii_review_receipt_link();

CREATE OR REPLACE FUNCTION prevent_subscriber_pii_review_receipt_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'PII review receipts are immutable'
        USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS subscriber_pii_review_receipts_immutable ON subscriber_pii_review_receipts;
CREATE TRIGGER subscriber_pii_review_receipts_immutable
    BEFORE UPDATE ON subscriber_pii_review_receipts
    FOR EACH ROW EXECUTE FUNCTION prevent_subscriber_pii_review_receipt_update();

-- Runtime callers may insert a receipt only through the review transaction and
-- may never update/delete either side directly. FK cascades still execute for
-- a legitimate subscriber/tenant erasure, preserving the product's data-
-- minimisation contract instead of retaining a subject-linked receipt forever.
REVOKE DELETE, TRUNCATE ON subscriber_pii_findings FROM postwave_app, PUBLIC;
GRANT SELECT, INSERT ON subscriber_pii_review_receipts TO postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON subscriber_pii_review_receipts FROM postwave_app, PUBLIC;

ALTER TABLE subscriber_pii_review_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_pii_review_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_pii_review_receipts
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_pii_review_receipts
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;

-- Evidence identity is version-aware. A detector/policy change creates a new
-- review item; it never collides with, relabels, or overwrites an earlier
-- finding and its immutable receipt.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_versioned_evidence_uniq_idx
    ON subscriber_pii_findings (
        tenant_id, subscriber_id, field_name, detected_type, raw_value_hash,
        fingerprint_scheme, fingerprint_key_version,
        scanner_name, scanner_version, detector_name, detector_version,
        policy_name, policy_version
    );

BEGIN;
ALTER TABLE subscriber_pii_findings
    DROP CONSTRAINT IF EXISTS subscriber_pii_findings_tenant_id_subscriber_id_field_name__key;
COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_review_receipts_tenant_reviewed_idx
    ON subscriber_pii_review_receipts (tenant_id, reviewed_at DESC, finding_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_type_status_page_idx
    ON subscriber_pii_findings (tenant_id, detected_type, status, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_field_name_trgm_idx
    ON subscriber_pii_findings USING GIN (lower(field_name) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_fingerprint_prefix_idx
    ON subscriber_pii_findings (raw_value_hash text_pattern_ops, tenant_id)
    WHERE fingerprint_scheme = 'hmac-sha256-v1';

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_tenant_created_page_idx
    ON subscriber_pii_findings (tenant_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_pii_findings_subscriber_page_idx
    ON subscriber_pii_findings (tenant_id, subscriber_id, created_at DESC, id DESC);
