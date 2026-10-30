-- 1761_subscriber_import_consent_contract.sql
--
-- SUB-102 / P0-04 / P1-08 — fail-closed subscriber-import consent.
--
-- A source label, URL, and timestamp are provenance, but are not enough to
-- prove an email-marketing grant.  This migration adds the rest of the
-- reviewed contract, binds confirmation to an exhaustive preflight and the
-- exact uploaded bytes, and creates an immutable per-applied-row receipt.
-- Rows without the complete contract remain unconfirmed and non-sendable.
-- Existing subscribers retain their status and consent vector; an import may
-- enrich their tags/properties, but cannot silently undo an unsubscribe,
-- complaint, blocklist, or other protected state.

-- Composite parents used by the tenant-bound receipt foreign keys.  These are
-- online because subscriber/consent ledgers can be large in production.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscriber_imports_tenant_id_unique_idx
    ON subscriber_imports (tenant_id, id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS consent_records_tenant_id_unique_idx
    ON consent_records (tenant_id, id);

BEGIN;

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS consent_legal_basis       text,
    ADD COLUMN IF NOT EXISTS consent_jurisdiction      text,
    ADD COLUMN IF NOT EXISTS consent_reason            text,
    ADD COLUMN IF NOT EXISTS consent_policy_version    text,
    ADD COLUMN IF NOT EXISTS consent_evidence_reference text,
    ADD COLUMN IF NOT EXISTS consent_scope             text,
    ADD COLUMN IF NOT EXISTS consent_scope_acknowledged boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS consent_contract_version  text NOT NULL DEFAULT 'subscriber-import-consent/v1',
    ADD COLUMN IF NOT EXISTS source_fingerprint         text,
    ADD COLUMN IF NOT EXISTS source_fingerprint_scheme  text,
    ADD COLUMN IF NOT EXISTS source_fingerprint_key_version text,
    ADD COLUMN IF NOT EXISTS preflight_fingerprint      text,
    ADD COLUMN IF NOT EXISTS preflight_at               timestamptz,
    ADD COLUMN IF NOT EXISTS preflight_expires_at       timestamptz,
    ADD COLUMN IF NOT EXISTS preflight_rows_total       bigint,
    ADD COLUMN IF NOT EXISTS preflight_rows_failed      bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS preflight_rows_existing    bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS preflight_state_fingerprint text,
    ADD COLUMN IF NOT EXISTS preflight_catalog_fingerprint text,
    ADD COLUMN IF NOT EXISTS execution_state_fingerprint text,
    ADD COLUMN IF NOT EXISTS confirmed_consent_fingerprint text,
    ADD COLUMN IF NOT EXISTS rows_sendable_after        bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rows_protected_existing    bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS consent_receipts_written   bigint NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS source_delete_after        timestamptz DEFAULT (now() + interval '24 hours'),
	ADD COLUMN IF NOT EXISTS review_data_expires_at     timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
	ADD COLUMN IF NOT EXISTS sample_values_truncated    boolean NOT NULL DEFAULT false,
	ADD COLUMN IF NOT EXISTS error_code                 text;

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS claim_generation bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS configuration_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE subscriber_import_errors
    ADD COLUMN IF NOT EXISTS error_code text NOT NULL DEFAULT 'row_validation_failed',
    ADD COLUMN IF NOT EXISTS email_sha256 text,
    ADD COLUMN IF NOT EXISTS raw_row_sha256 text,
    ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days');

-- The old retry surface was never mounted. Raw CSV records, email copies, and
-- deterministic hashes are all unnecessary secondary identity stores. Retain
-- only import_id + row_number + a safe bounded outcome code/message.
UPDATE subscriber_import_errors
   SET email = NULL,
       raw_row = NULL,
       email_sha256 = NULL,
       raw_row_sha256 = NULL,
       expires_at = LEAST(expires_at, now() + interval '30 days');

-- Existing queued/running jobs still need their source. Preview objects expire
-- 24 hours after upload; terminal objects are eligible immediately.
UPDATE subscriber_imports
   SET source_delete_after = CASE
	   WHEN status IN ('queued','running') THEN NULL
	   WHEN status = 'preview' THEN LEAST(now() + interval '24 hours', created_at + interval '24 hours')
	   ELSE now()
   END,
       review_data_expires_at = CASE
	   WHEN status IN ('ready','failed','cancelled') THEN now() + interval '24 hours'
	   ELSE GREATEST(review_data_expires_at, now() + interval '24 hours')
   END;

UPDATE subscriber_imports
   SET error_code = CASE WHEN status = 'failed' THEN 'import_failed' ELSE NULL END,
       error = CASE WHEN status = 'failed' THEN 'The subscriber import failed safely.' ELSE NULL END;

UPDATE subscriber_imports SET on_existing = 'update' WHERE on_existing = 'replace';
ALTER TABLE subscriber_imports
	DROP CONSTRAINT IF EXISTS subscriber_imports_on_existing_check,
	ADD CONSTRAINT subscriber_imports_on_existing_check CHECK (on_existing IN ('skip','update','error'));

ALTER TABLE subscriber_import_errors
    DROP CONSTRAINT IF EXISTS subscriber_import_errors_privacy_safe_payload_check,
    ADD CONSTRAINT subscriber_import_errors_privacy_safe_payload_check CHECK (
        email IS NULL
        AND raw_row IS NULL
        AND email_sha256 IS NULL
        AND raw_row_sha256 IS NULL
        AND length(error_code) BETWEEN 1 AND 64
        AND length(error) BETWEEN 1 AND 500
    );

CREATE OR REPLACE FUNCTION validate_subscriber_import_error_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF NEW.email IS NOT NULL OR NEW.raw_row IS NOT NULL
       OR NEW.email_sha256 IS NOT NULL OR NEW.raw_row_sha256 IS NOT NULL THEN
        RAISE EXCEPTION 'subscriber import errors cannot retain raw CSV values'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.error ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
       OR NEW.error ~* '(bearer[[:space:]]+|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|sk-[a-z0-9_-]{8,})'
    THEN
        RAISE EXCEPTION 'subscriber import error messages cannot contain raw identities or secrets'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS subscriber_import_errors_validate_payload ON subscriber_import_errors;
CREATE TRIGGER subscriber_import_errors_validate_payload
    BEFORE INSERT OR UPDATE ON subscriber_import_errors
    FOR EACH ROW EXECUTE FUNCTION validate_subscriber_import_error_payload();

ALTER TABLE subscriber_imports
    DROP CONSTRAINT IF EXISTS subscriber_imports_positive_consent_contract_check,
    ADD CONSTRAINT subscriber_imports_positive_consent_contract_check CHECK (
        NOT consent_scope_acknowledged OR (
            lower(btrim(COALESCE(consent_source, ''))) IN (
                'double_optin','single_optin','signed_form',
                'preference_center','direct_request'
            )
            AND COALESCE(consent_source_url, '') ~ '^https://[^[:space:]]+$'
            AND consent_captured_at IS NOT NULL
            AND consent_legal_basis = 'consent'
            AND length(btrim(COALESCE(consent_jurisdiction, ''))) BETWEEN 2 AND 32
            AND length(btrim(COALESCE(consent_reason, ''))) BETWEEN 1 AND 500
            AND length(btrim(COALESCE(consent_policy_version, ''))) BETWEEN 1 AND 100
            AND COALESCE(consent_evidence_reference, '') ~
                '^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$'
            AND consent_scope = 'email_marketing'
            AND consent_contract_version = 'subscriber-import-consent/v1'
        )
    ),
	DROP CONSTRAINT IF EXISTS subscriber_imports_source_fingerprint_check,
	ADD CONSTRAINT subscriber_imports_source_fingerprint_check CHECK (
	    (source_fingerprint IS NULL AND source_fingerprint_scheme IS NULL AND source_fingerprint_key_version IS NULL)
	    OR (
	        source_fingerprint ~ '^[0-9a-f]{64}$'
	        AND source_fingerprint_scheme = 'hmac-sha256-v1'
	        AND source_fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
	    )
    ),
    DROP CONSTRAINT IF EXISTS subscriber_imports_preflight_fingerprint_check,
    ADD CONSTRAINT subscriber_imports_preflight_fingerprint_check CHECK (
		(
			preflight_fingerprint IS NULL AND preflight_at IS NULL AND preflight_expires_at IS NULL
			AND preflight_rows_total IS NULL AND preflight_state_fingerprint IS NULL
			AND preflight_catalog_fingerprint IS NULL
		)
		OR (
			preflight_fingerprint ~ '^[0-9a-f]{64}$'
			AND source_fingerprint ~ '^[0-9a-f]{64}$'
			AND source_fingerprint_scheme = 'hmac-sha256-v1'
			AND source_fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
			AND preflight_at IS NOT NULL AND preflight_expires_at > preflight_at
			AND preflight_rows_total IS NOT NULL AND preflight_rows_total = rows_total
			AND preflight_rows_failed BETWEEN 0 AND preflight_rows_total
			AND preflight_rows_existing BETWEEN 0 AND preflight_rows_total
			AND preflight_state_fingerprint ~ '^[0-9a-f]{64}$'
			AND preflight_catalog_fingerprint ~ '^[0-9a-f]{64}$'
		)
    ),
	DROP CONSTRAINT IF EXISTS subscriber_imports_execution_state_fingerprint_check,
	ADD CONSTRAINT subscriber_imports_execution_state_fingerprint_check CHECK (
		execution_state_fingerprint IS NULL OR execution_state_fingerprint ~ '^[0-9a-f]{64}$'
	),
    DROP CONSTRAINT IF EXISTS subscriber_imports_confirmed_consent_fingerprint_check,
    ADD CONSTRAINT subscriber_imports_confirmed_consent_fingerprint_check CHECK (
        confirmed_consent_fingerprint IS NULL OR confirmed_consent_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    DROP CONSTRAINT IF EXISTS subscriber_imports_consent_counters_check,
    ADD CONSTRAINT subscriber_imports_consent_counters_check CHECK (
        rows_sendable_after >= 0
        AND rows_protected_existing >= 0
        AND consent_receipts_written >= 0
        AND claim_generation >= 0
        AND configuration_revision >= 0
        AND (preflight_rows_total IS NULL OR preflight_rows_total >= 0)
		AND preflight_rows_failed >= 0
		AND preflight_rows_existing >= 0
	),
	DROP CONSTRAINT IF EXISTS subscriber_imports_safe_error_check,
	ADD CONSTRAINT subscriber_imports_safe_error_check CHECK (
		(error_code IS NULL AND error IS NULL)
		OR (
			status = 'failed'
			AND error_code ~ '^[a-z][a-z0-9_]{0,63}$'
			AND length(error) BETWEEN 1 AND 200
			AND error !~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
		)
    );

CREATE TABLE IF NOT EXISTS subscriber_import_consent_approvals (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    import_id                uuid NOT NULL,
    consent_fingerprint      text NOT NULL CHECK (consent_fingerprint ~ '^[0-9a-f]{64}$'),
    source_file_fingerprint  text NOT NULL CHECK (source_file_fingerprint ~ '^[0-9a-f]{64}$'),
    source_fingerprint_scheme text NOT NULL CHECK (source_fingerprint_scheme = 'hmac-sha256-v1'),
    source_fingerprint_key_version text NOT NULL CHECK (
        source_fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
    consent_source           text NOT NULL CHECK (consent_source IN (
                                 'double_optin','single_optin','signed_form',
                                 'preference_center','direct_request'
                             )),
    source_url               text NOT NULL CHECK (source_url ~ '^https://[^[:space:]]+$'),
    captured_at              timestamptz NOT NULL,
    legal_basis              text NOT NULL CHECK (legal_basis = 'consent'),
    jurisdiction             text NOT NULL CHECK (length(btrim(jurisdiction)) BETWEEN 2 AND 32),
    reason                   text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    policy_version           text NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 100),
    evidence_reference       text NOT NULL CHECK (
        evidence_reference ~ '^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$'
    ),
    scope                    text NOT NULL CHECK (scope = 'email_marketing'),
    contract_version         text NOT NULL CHECK (contract_version = 'subscriber-import-consent/v1'),
    approved_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, import_id),
    FOREIGN KEY (tenant_id, import_id)
        REFERENCES subscriber_imports (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE subscriber_import_consent_approvals IS
    'One immutable normalized consent contract per confirmed import; row ledgers link here instead of duplicating free text and URLs.';

CREATE TABLE IF NOT EXISTS subscriber_import_consent_receipts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    import_id             uuid NOT NULL,
    approval_id           uuid NOT NULL,
    subscriber_id         uuid NOT NULL,
    consent_record_id     uuid NOT NULL,
    source_row_fingerprint text NOT NULL CHECK (source_row_fingerprint ~ '^[0-9a-f]{64}$'),
    evidence_fingerprint   text NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
    source_file_fingerprint text NOT NULL CHECK (source_file_fingerprint ~ '^[0-9a-f]{64}$'),
    operation              text NOT NULL CHECK (operation IN ('created','updated')),
	status_before          text CHECK (status_before IS NULL OR status_before IN ('enabled','disabled','blocklisted','unconfirmed')),
    status_after           text NOT NULL CHECK (status_after IN ('enabled','disabled','blocklisted','unconfirmed')),
    sendable_before        boolean NOT NULL,
    sendable_after         boolean NOT NULL,
    eligibility_transition_applied boolean NOT NULL,
    applied_at             timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (operation = 'created' AND status_before IS NULL AND eligibility_transition_applied)
        OR
        (operation = 'updated' AND status_before IS NOT NULL AND NOT eligibility_transition_applied)
    ),
    CHECK (NOT sendable_after OR status_after = 'enabled')
);

COMMENT ON TABLE subscriber_import_consent_receipts IS
    'Compact immutable idempotency/link receipt for an applied import row; reviewed legal evidence is normalized in subscriber_import_consent_approvals.';

GRANT SELECT ON subscriber_import_consent_approvals TO postwave_app;
GRANT SELECT, INSERT ON subscriber_import_consent_receipts TO postwave_app;
REVOKE INSERT ON subscriber_import_consent_approvals FROM postwave_app, PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON subscriber_import_consent_approvals, subscriber_import_consent_receipts FROM postwave_app, PUBLIC;

ALTER TABLE subscriber_import_consent_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_import_consent_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_import_consent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_import_consent_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY subscriber_import_consent_approvals_tenant_isolation
    ON subscriber_import_consent_approvals AS RESTRICTIVE FOR ALL
	USING (
		tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
		OR current_setting('app.outbox_worker', true) = 'true'
	)
	WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY subscriber_import_consent_approvals_tenant_visible
    ON subscriber_import_consent_approvals AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY subscriber_import_consent_approvals_worker_visible
	ON subscriber_import_consent_approvals AS PERMISSIVE FOR SELECT TO postwave_app
	USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY subscriber_import_consent_receipts_tenant_isolation
    ON subscriber_import_consent_receipts AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY subscriber_import_consent_receipts_tenant_visible
    ON subscriber_import_consent_receipts AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION prevent_subscriber_import_consent_evidence_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
    RAISE EXCEPTION 'subscriber import consent evidence is immutable' USING ERRCODE = '23514';
END;
$fn$;

DROP TRIGGER IF EXISTS subscriber_import_consent_approvals_immutable ON subscriber_import_consent_approvals;
CREATE TRIGGER subscriber_import_consent_approvals_immutable
    BEFORE UPDATE ON subscriber_import_consent_approvals
    FOR EACH ROW EXECUTE FUNCTION prevent_subscriber_import_consent_evidence_update();
DROP TRIGGER IF EXISTS subscriber_import_consent_receipts_immutable ON subscriber_import_consent_receipts;
CREATE TRIGGER subscriber_import_consent_receipts_immutable
    BEFORE UPDATE ON subscriber_import_consent_receipts
    FOR EACH ROW EXECUTE FUNCTION prevent_subscriber_import_consent_evidence_update();

-- Canonical cross-language hash framing: each UTF-8 part is prefixed with a
-- four-byte network-order length. This is collision-safe without PostgreSQL's
-- forbidden NUL text character and mirrors sha256LengthPrefixed in Go.
CREATE OR REPLACE FUNCTION subscriber_import_sha256_parts(VARIADIC p_parts text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $fn$
	SELECT encode(digest(
		COALESCE(string_agg(
			int4send(octet_length(convert_to(part, 'UTF8')))
			|| convert_to(part, 'UTF8'), ''::bytea ORDER BY ord
		), ''::bytea),
		'sha256'
	), 'hex')
	FROM unnest(p_parts) WITH ORDINALITY AS framed(part, ord);
$fn$;

REVOKE ALL ON FUNCTION subscriber_import_sha256_parts(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subscriber_import_sha256_parts(text[]) TO postwave_app;

CREATE OR REPLACE FUNCTION validate_subscriber_import_consent_approval_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
    job subscriber_imports%ROWTYPE;
    expected_consent_fingerprint text;
BEGIN
    SELECT * INTO job FROM subscriber_imports
     WHERE tenant_id = NEW.tenant_id AND id = NEW.import_id FOR SHARE;
	expected_consent_fingerprint := subscriber_import_sha256_parts(
		'subscriber-import-consent-fingerprint/v1', 'subscriber-import-consent/v1',
		lower(btrim(job.consent_source)), job.consent_source_url,
		(floor(extract(epoch FROM job.consent_captured_at) * 1000000)::bigint)::text,
		'consent', upper(btrim(job.consent_jurisdiction)), btrim(job.consent_reason),
		btrim(job.consent_policy_version), btrim(job.consent_evidence_reference), 'email_marketing'
	);
    IF NOT FOUND OR job.status <> 'preview'
       OR job.confirmed_consent_fingerprint IS NOT NULL
	   OR job.preflight_fingerprint IS NULL OR job.preflight_at IS NULL
	   OR job.preflight_expires_at <= clock_timestamp()
	   OR job.preflight_rows_total IS NULL
	   OR job.preflight_state_fingerprint IS NULL
	   OR job.preflight_catalog_fingerprint IS NULL
	   OR NEW.consent_fingerprint IS DISTINCT FROM expected_consent_fingerprint
       OR job.source_fingerprint IS DISTINCT FROM NEW.source_file_fingerprint
       OR job.source_fingerprint_scheme IS DISTINCT FROM NEW.source_fingerprint_scheme
       OR job.source_fingerprint_key_version IS DISTINCT FROM NEW.source_fingerprint_key_version
       OR lower(btrim(job.consent_source)) IS DISTINCT FROM NEW.consent_source
       OR job.consent_source_url IS DISTINCT FROM NEW.source_url
       OR job.consent_captured_at IS DISTINCT FROM NEW.captured_at
       OR job.consent_legal_basis IS DISTINCT FROM NEW.legal_basis
       OR job.consent_jurisdiction IS DISTINCT FROM NEW.jurisdiction
       OR job.consent_reason IS DISTINCT FROM NEW.reason
       OR job.consent_policy_version IS DISTINCT FROM NEW.policy_version
       OR job.consent_evidence_reference IS DISTINCT FROM NEW.evidence_reference
       OR job.consent_scope IS DISTINCT FROM NEW.scope
       OR NOT job.consent_scope_acknowledged
       OR job.consent_contract_version IS DISTINCT FROM NEW.contract_version THEN
        RAISE EXCEPTION 'consent approval does not match the locked import contract' USING ERRCODE = '23514';
    END IF;
    IF NEW.captured_at > clock_timestamp()
       OR NEW.source_url ~* 'https://[^/[:space:]]+@'
       OR NEW.source_url ~* '[?&]([^=&]*(key|token|secret|password|passwd|signature|credential)[^=&]*)='
       OR NEW.reason ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
       OR NEW.reason ~ '[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}'
       OR NEW.reason ~ '([0-9]{1,3}\.){3}[0-9]{1,3}'
       OR NEW.reason ~ '([0-9][ -]?){12,18}[0-9]'
       OR (NEW.source_url || NEW.reason || NEW.policy_version || NEW.evidence_reference)
          ~* '(bearer[[:space:]]+|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|sk-[a-z0-9_-]{8,})' THEN
        RAISE EXCEPTION 'consent approval contains future, secret, or personal evidence text' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS subscriber_import_consent_approvals_validate_insert ON subscriber_import_consent_approvals;
CREATE TRIGGER subscriber_import_consent_approvals_validate_insert
    BEFORE INSERT ON subscriber_import_consent_approvals
    FOR EACH ROW EXECUTE FUNCTION validate_subscriber_import_consent_approval_insert();

CREATE OR REPLACE FUNCTION create_subscriber_import_consent_approval(
	p_tenant_id uuid,
	p_import_id uuid,
	p_preflight_fingerprint text,
	p_configuration_revision bigint,
	p_expected_consent_fingerprint text
)
RETURNS TABLE (approval_id uuid, consent_fingerprint text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
	job subscriber_imports%ROWTYPE;
	computed_fingerprint text;
BEGIN
	IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
		RAISE EXCEPTION 'subscriber import approval tenant mismatch' USING ERRCODE = '42501';
	END IF;
	SELECT * INTO job
	  FROM subscriber_imports
	 WHERE tenant_id = p_tenant_id AND id = p_import_id
	 FOR UPDATE;
	IF NOT FOUND OR job.status <> 'preview'
	   OR job.configuration_revision IS DISTINCT FROM p_configuration_revision
	   OR job.preflight_fingerprint IS DISTINCT FROM p_preflight_fingerprint
	   OR job.preflight_at IS NULL OR job.preflight_expires_at <= clock_timestamp()
	   OR job.preflight_rows_total IS NULL
	   OR job.preflight_state_fingerprint IS NULL
	   OR job.preflight_catalog_fingerprint IS NULL
	   OR NOT job.consent_scope_acknowledged THEN
		RAISE EXCEPTION 'subscriber import approval snapshot is stale' USING ERRCODE = '40001';
	END IF;
	computed_fingerprint := subscriber_import_sha256_parts(
		'subscriber-import-consent-fingerprint/v1', 'subscriber-import-consent/v1',
		lower(btrim(job.consent_source)), job.consent_source_url,
		(floor(extract(epoch FROM job.consent_captured_at) * 1000000)::bigint)::text,
		'consent', upper(btrim(job.consent_jurisdiction)), btrim(job.consent_reason),
		btrim(job.consent_policy_version), btrim(job.consent_evidence_reference), 'email_marketing'
	);
	IF computed_fingerprint IS DISTINCT FROM p_expected_consent_fingerprint THEN
		RAISE EXCEPTION 'subscriber import approval fingerprint mismatch' USING ERRCODE = '23514';
	END IF;
	RETURN QUERY
	INSERT INTO subscriber_import_consent_approvals (
		tenant_id, import_id, consent_fingerprint, source_file_fingerprint,
		source_fingerprint_scheme, source_fingerprint_key_version,
		consent_source, source_url, captured_at, legal_basis, jurisdiction,
		reason, policy_version, evidence_reference, scope, contract_version
	) VALUES (
		job.tenant_id, job.id, computed_fingerprint, job.source_fingerprint,
		job.source_fingerprint_scheme, job.source_fingerprint_key_version,
		lower(btrim(job.consent_source)), job.consent_source_url, job.consent_captured_at,
		job.consent_legal_basis, upper(btrim(job.consent_jurisdiction)), btrim(job.consent_reason),
		btrim(job.consent_policy_version), btrim(job.consent_evidence_reference),
		job.consent_scope, job.consent_contract_version
	)
	RETURNING id, subscriber_import_consent_approvals.consent_fingerprint;
END;
$fn$;

REVOKE ALL ON FUNCTION create_subscriber_import_consent_approval(uuid, uuid, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_subscriber_import_consent_approval(uuid, uuid, text, bigint, text) TO postwave_app;

CREATE OR REPLACE FUNCTION validate_subscriber_import_consent_receipt_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
    approval subscriber_import_consent_approvals%ROWTYPE;
    record consent_records%ROWTYPE;
    current_status text;
    current_sendable boolean;
    expected_source text;
    expected_evidence text;
BEGIN
    SELECT * INTO approval FROM subscriber_import_consent_approvals
     WHERE tenant_id = NEW.tenant_id AND id = NEW.approval_id AND import_id = NEW.import_id;
    SELECT * INTO record FROM consent_records
     WHERE tenant_id = NEW.tenant_id AND id = NEW.consent_record_id AND subscriber_id = NEW.subscriber_id;
    IF approval.id IS NULL OR record.id IS NULL THEN
        RAISE EXCEPTION 'receipt approval/consent/subscriber linkage is invalid' USING ERRCODE = '23514';
    END IF;
    expected_source := CASE approval.consent_source
        WHEN 'signed_form' THEN 'form'
        WHEN 'direct_request' THEN 'admin'
        ELSE approval.consent_source END;
    expected_evidence := subscriber_import_sha256_parts(
		'subscriber-import-evidence/v1', approval.consent_fingerprint, NEW.source_row_fingerprint
	);
    IF NEW.source_file_fingerprint IS DISTINCT FROM approval.source_file_fingerprint
       OR NEW.evidence_fingerprint IS DISTINCT FROM expected_evidence
       OR record.channel <> 'email' OR record.consent_status <> 'granted'
       OR record.source <> expected_source OR record.source_url IS NOT NULL
       OR record.captured_at IS DISTINCT FROM approval.captured_at
       OR record.evidence->>'import_id' IS DISTINCT FROM NEW.import_id::text
       OR record.evidence->>'approval_id' IS DISTINCT FROM NEW.approval_id::text
       OR record.evidence->>'source_row_fingerprint' IS DISTINCT FROM NEW.source_row_fingerprint
       OR record.evidence->>'evidence_fingerprint' IS DISTINCT FROM NEW.evidence_fingerprint THEN
        RAISE EXCEPTION 'receipt does not match normalized approval and consent ledger' USING ERRCODE = '23514';
    END IF;
    SELECT s.status,
           s.status = 'enabled' AND s.consent_email_marketing_at IS NOT NULL
           AND s.archived_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM v_suppressions_unified v
                WHERE v.tenant_id = s.tenant_id AND lower(v.email) = lower(s.email::text)
                  AND (v.expires_at IS NULL OR v.expires_at > now())
           )
      INTO current_status, current_sendable
      FROM subscribers s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.subscriber_id;
    IF current_status IS NULL OR current_status IS DISTINCT FROM NEW.status_after
       OR current_sendable IS DISTINCT FROM NEW.sendable_after THEN
        RAISE EXCEPTION 'receipt outcome does not match subscriber state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS subscriber_import_consent_receipts_validate_insert ON subscriber_import_consent_receipts;
CREATE TRIGGER subscriber_import_consent_receipts_validate_insert
    BEFORE INSERT ON subscriber_import_consent_receipts
    FOR EACH ROW EXECUTE FUNCTION validate_subscriber_import_consent_receipt_insert();

-- A preflight is proof about exact inputs.  Any mutation that could change row
-- shaping, collision handling, or consent eligibility invalidates it even for
-- direct SQL callers; the next confirm must obtain a fresh exhaustive pass.
CREATE OR REPLACE FUNCTION invalidate_subscriber_import_preflight()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF OLD.status = 'preview' AND (
        OLD.mapping IS DISTINCT FROM NEW.mapping
        OR OLD.on_existing IS DISTINCT FROM NEW.on_existing
        OR OLD.consent_source IS DISTINCT FROM NEW.consent_source
        OR OLD.consent_source_url IS DISTINCT FROM NEW.consent_source_url
        OR OLD.consent_captured_at IS DISTINCT FROM NEW.consent_captured_at
        OR OLD.consent_legal_basis IS DISTINCT FROM NEW.consent_legal_basis
        OR OLD.consent_jurisdiction IS DISTINCT FROM NEW.consent_jurisdiction
        OR OLD.consent_reason IS DISTINCT FROM NEW.consent_reason
        OR OLD.consent_policy_version IS DISTINCT FROM NEW.consent_policy_version
        OR OLD.consent_evidence_reference IS DISTINCT FROM NEW.consent_evidence_reference
        OR OLD.consent_scope IS DISTINCT FROM NEW.consent_scope
        OR OLD.consent_scope_acknowledged IS DISTINCT FROM NEW.consent_scope_acknowledged
        OR OLD.tags IS DISTINCT FROM NEW.tags
        OR OLD.auto_create_properties IS DISTINCT FROM NEW.auto_create_properties
		OR OLD.schedule_type IS DISTINCT FROM NEW.schedule_type
		OR OLD.schedule_cron IS DISTINCT FROM NEW.schedule_cron
		OR OLD.scheduled_at IS DISTINCT FROM NEW.scheduled_at
		OR OLD.drip_hours_interval IS DISTINCT FROM NEW.drip_hours_interval
		OR OLD.drip_hours_total IS DISTINCT FROM NEW.drip_hours_total
    ) THEN
        NEW.configuration_revision := OLD.configuration_revision + 1;
        NEW.preflight_fingerprint := NULL;
        NEW.preflight_at := NULL;
		NEW.preflight_expires_at := NULL;
        NEW.preflight_rows_total := NULL;
		NEW.preflight_rows_failed := 0;
		NEW.preflight_rows_existing := 0;
		NEW.preflight_state_fingerprint := NULL;
		NEW.preflight_catalog_fingerprint := NULL;
		NEW.execution_state_fingerprint := NULL;
		NEW.dry_run := false;
		NEW.dry_run_results := NULL;
		NEW.dry_run_at := NULL;
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS subscriber_imports_invalidate_preflight ON subscriber_imports;
CREATE TRIGGER subscriber_imports_invalidate_preflight
    BEFORE UPDATE ON subscriber_imports
    FOR EACH ROW EXECUTE FUNCTION invalidate_subscriber_import_preflight();

-- Retire unreachable recurring/drip values before validating the one-time
-- contract. A future scheduled_at remains a one-time scheduled job; all other
-- legacy shapes become immediate and must obtain a fresh preflight if preview.
UPDATE subscriber_imports
   SET schedule_type = CASE WHEN scheduled_at IS NULL THEN 'immediate' ELSE 'scheduled' END,
	   schedule_cron = NULL,
	   drip_hours_interval = 0,
	   drip_hours_total = 0
 WHERE COALESCE(schedule_type, 'immediate') NOT IN ('immediate','scheduled')
	OR NULLIF(btrim(COALESCE(schedule_cron, '')), '') IS NOT NULL
	OR COALESCE(drip_hours_interval, 0) <> 0
	OR COALESCE(drip_hours_total, 0) <> 0
	OR (COALESCE(schedule_type, 'immediate') = 'immediate' AND scheduled_at IS NOT NULL)
	OR (schedule_type = 'scheduled' AND scheduled_at IS NULL);

ALTER TABLE subscriber_imports
	DROP CONSTRAINT IF EXISTS subscriber_imports_one_time_schedule_check,
	ADD CONSTRAINT subscriber_imports_one_time_schedule_check CHECK (
		COALESCE(schedule_type, 'immediate') IN ('immediate','scheduled')
		AND NULLIF(btrim(COALESCE(schedule_cron, '')), '') IS NULL
		AND COALESCE(drip_hours_interval, 0) = 0
		AND COALESCE(drip_hours_total, 0) = 0
		AND (
			(COALESCE(schedule_type, 'immediate') = 'immediate' AND scheduled_at IS NULL)
			OR (schedule_type = 'scheduled' AND scheduled_at IS NOT NULL)
		)
	);

CREATE OR REPLACE FUNCTION validate_subscriber_tag_budget()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE tag text; normalized text[] := '{}'::text[]; total_bytes integer := 0;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.tags IS NOT DISTINCT FROM OLD.tags THEN RETURN NEW; END IF;
	IF cardinality(COALESCE(NEW.tags, '{}'::text[])) > 50 THEN
		RAISE EXCEPTION 'subscriber tags exceed 50-item limit' USING ERRCODE = '23514';
	END IF;
	FOREACH tag IN ARRAY COALESCE(NEW.tags, '{}'::text[]) LOOP
		IF btrim(tag) = '' OR char_length(tag) > 100 OR octet_length(tag) > 400
		   OR lower(tag) = ANY(normalized) THEN
			RAISE EXCEPTION 'subscriber tags violate canonical item budget/dedupe' USING ERRCODE = '23514';
		END IF;
		normalized := array_append(normalized, lower(tag));
		total_bytes := total_bytes + octet_length(tag);
	END LOOP;
	IF total_bytes > 4096 THEN
		RAISE EXCEPTION 'subscriber tags exceed 4096-byte limit' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS subscribers_validate_tag_budget ON subscribers;
CREATE TRIGGER subscribers_validate_tag_budget
	BEFORE INSERT OR UPDATE OF tags ON subscribers
	FOR EACH ROW EXECUTE FUNCTION validate_subscriber_tag_budget();

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS subscriber_import_consent_receipts_row_idx
    ON subscriber_import_consent_receipts (tenant_id, import_id, source_row_fingerprint);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_import_consent_receipts_subscriber_idx
    ON subscriber_import_consent_receipts (tenant_id, subscriber_id, applied_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_import_consent_receipts_consent_record_idx
    ON subscriber_import_consent_receipts (tenant_id, consent_record_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_import_errors_expiry_idx
    ON subscriber_import_errors (expires_at, id);

BEGIN;

ALTER TABLE subscriber_import_consent_receipts
    ADD CONSTRAINT subscriber_import_consent_receipts_row_unique
        UNIQUE USING INDEX subscriber_import_consent_receipts_row_idx,
    ADD CONSTRAINT subscriber_import_consent_receipts_import_fk
        FOREIGN KEY (tenant_id, import_id)
	    REFERENCES subscriber_imports (tenant_id, id) ON DELETE CASCADE,
	ADD CONSTRAINT subscriber_import_consent_receipts_approval_fk
	    FOREIGN KEY (tenant_id, approval_id)
	    REFERENCES subscriber_import_consent_approvals (tenant_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT subscriber_import_consent_receipts_subscriber_fk
        FOREIGN KEY (tenant_id, subscriber_id)
	    REFERENCES subscribers (tenant_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT subscriber_import_consent_receipts_consent_record_fk
        FOREIGN KEY (tenant_id, consent_record_id)
	    REFERENCES consent_records (tenant_id, id) ON DELETE CASCADE;

COMMIT;
