-- 2015_campaign_poll_token_provenance.sql
--
-- F14 v3 closes four boundaries that v2 could not prove:
--
--   * every bearer binds an exact immutable content revision, key id, issue
--     time, and expiry;
--   * GET is side-effect-free (confirmation challenges are signed/stateless);
--   * every distinct POST creates an immutable classifier/provenance receipt;
--   * the mutable response table is only the current one-choice projection.
--
-- Existing v2 polls cannot be assigned an honest revision after the fact. They
-- are retained as evidence but quarantined (`accepting_responses=false`), so
-- deploying this migration invalidates their unversioned forever-links.
--
-- migration-execution: phased
-- rollback-strategy: no-op

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE campaign_polls
    ADD COLUMN IF NOT EXISTS content_revision_id uuid,
    ADD COLUMN IF NOT EXISTS content_revision_source_hash text,
    ADD COLUMN IF NOT EXISTS poll_contract_sha256 text,
    ADD COLUMN IF NOT EXISTS token_version smallint NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS accepting_responses boolean NOT NULL DEFAULT false;

-- No legacy row can prove which revision was used when it was materialized.
UPDATE campaign_polls
   SET token_version = 2,
       accepting_responses = false
 WHERE content_revision_id IS NULL;

ALTER TABLE campaign_polls
    DROP CONSTRAINT IF EXISTS campaign_polls_content_revision_fk,
    ADD CONSTRAINT campaign_polls_content_revision_fk
        FOREIGN KEY (tenant_id, campaign_id, content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, campaign_id, id)
        ON DELETE RESTRICT
        NOT VALID,
    DROP CONSTRAINT IF EXISTS campaign_polls_token_provenance_shape,
    ADD CONSTRAINT campaign_polls_token_provenance_shape CHECK (
        (token_version = 2
            AND content_revision_id IS NULL
            AND content_revision_source_hash IS NULL
            AND poll_contract_sha256 IS NULL
            AND NOT accepting_responses)
        OR
        (token_version = 3
            AND campaign_id IS NOT NULL
            AND content_revision_id IS NOT NULL
            AND content_revision_source_hash ~ '^[0-9a-f]{64}$'
            AND poll_contract_sha256 ~ '^[0-9a-f]{64}$')
    ) NOT VALID;

ALTER TABLE campaign_polls
    VALIDATE CONSTRAINT campaign_polls_content_revision_fk;
ALTER TABLE campaign_polls
    VALIDATE CONSTRAINT campaign_polls_token_provenance_shape;

ALTER TABLE campaign_poll_responses
    ADD COLUMN IF NOT EXISTS content_revision_id uuid,
    ADD COLUMN IF NOT EXISTS token_key_id text,
    ADD COLUMN IF NOT EXISTS token_issued_at timestamptz,
    ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS active_receipt_id uuid;

ALTER TABLE campaign_poll_responses
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_state_check,
    ADD CONSTRAINT campaign_poll_responses_state_check CHECK (
        state IN (
            'previewed',
            'counted',
            'machine_excluded',
            'unclassified_excluded',
            'voided_multi_option',
            'superseded_choice'
        )
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_evidence_shape_check,
    ADD CONSTRAINT campaign_poll_responses_evidence_shape_check CHECK (
        (state = 'previewed' AND confirmed_at IS NULL)
        OR
        (state = 'counted'
            AND confirmed_at IS NOT NULL AND classification = 'human')
        OR
        (state = 'machine_excluded'
            AND confirmed_at IS NOT NULL AND classification = 'machine')
        OR
        (state = 'unclassified_excluded'
            AND confirmed_at IS NOT NULL AND classification = 'unknown')
        OR
        (state IN ('voided_multi_option', 'superseded_choice')
            AND confirmed_at IS NOT NULL AND classification IS NOT NULL)
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_v3_provenance_shape,
    ADD CONSTRAINT campaign_poll_responses_v3_provenance_shape CHECK (
        (content_revision_id IS NULL
            AND token_key_id IS NULL
            AND token_issued_at IS NULL
            AND token_expires_at IS NULL
            AND active_receipt_id IS NULL)
        OR
        (content_revision_id IS NOT NULL
            AND token_key_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'
            AND token_issued_at IS NOT NULL
            AND token_expires_at > token_issued_at
            AND active_receipt_id IS NOT NULL
            AND confirmed_at >= token_issued_at
            AND confirmed_at < token_expires_at)
    ) NOT VALID;

ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_state_check;
ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_evidence_shape_check;
ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_v3_provenance_shape;

COMMIT;

-- One semantic poll may be materialized independently for several immutable
-- revisions. Build the replacement before removing v2's tenant-wide key fence.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_revision_key_uniq
    ON campaign_polls (tenant_id, campaign_id, content_revision_id, poll_key)
    WHERE content_revision_id IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DROP INDEX IF EXISTS campaign_polls_key_uniq;

CREATE TABLE campaign_poll_response_receipts (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    poll_id                         uuid NOT NULL,
    option_id                       uuid NOT NULL,
    content_revision_id             uuid NOT NULL,
    content_revision_source_hash    text NOT NULL CHECK (
                                        content_revision_source_hash ~ '^[0-9a-f]{64}$'
                                    ),
    poll_contract_sha256            text NOT NULL CHECK (
                                        poll_contract_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    recipient_hash                  text NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
    link_token_sha256               text NOT NULL CHECK (link_token_sha256 ~ '^[0-9a-f]{64}$'),
    link_token_key_id               text NOT NULL CHECK (
                                        link_token_key_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'
                                    ),
    token_issued_at                 timestamptz NOT NULL,
    token_expires_at                timestamptz NOT NULL,
    confirmation_token_sha256       text CHECK (
                                        confirmation_token_sha256 IS NULL
                                        OR confirmation_token_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    submission_key_sha256           text NOT NULL CHECK (
                                        submission_key_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    initial_state                   text NOT NULL CHECK (initial_state IN (
                                        'counted', 'machine_excluded',
                                        'unclassified_excluded'
                                    )),
    classification                  text NOT NULL CHECK (
                                        classification IN ('human', 'machine', 'unknown')
                                    ),
    upstream_classification         text NOT NULL CHECK (
                                        upstream_classification IN ('human', 'machine', 'unknown')
                                    ),
    machine_subtype                 text,
    stable_reason                   text NOT NULL CHECK (
                                        stable_reason ~ '^R_[A-Z0-9_]{2,95}$'
                                    ),
    calibration_band                text,
    classifier_version              text,
    methodology_version             text,
    registry_version                text,
    configuration_hash              text,
    classifier_status               text NOT NULL CHECK (
                                        classifier_status IN ('ready', 'unavailable')
                                    ),
    explicit_browser_decision       boolean NOT NULL DEFAULT false,
    evidence_sha256                 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    rules                           jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
    conflicts                       jsonb NOT NULL CHECK (jsonb_typeof(conflicts) = 'array'),
    shadow_mode                     boolean NOT NULL,
    confirmed_at                    timestamptz NOT NULL,
    receipt_sha256                  text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
    created_at                      timestamptz NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT campaign_poll_receipt_poll_fk
        FOREIGN KEY (tenant_id, poll_id)
        REFERENCES campaign_polls (tenant_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT campaign_poll_receipt_option_fk
        FOREIGN KEY (tenant_id, poll_id, option_id)
        REFERENCES campaign_poll_options (tenant_id, poll_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT campaign_poll_receipt_revision_fk
        FOREIGN KEY (tenant_id, content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT campaign_poll_receipt_time_shape CHECK (
        token_expires_at > token_issued_at
        AND confirmed_at >= token_issued_at
        AND confirmed_at < token_expires_at
    ),
    CONSTRAINT campaign_poll_receipt_submission_shape CHECK (
        submission_key_sha256 = COALESCE(
            confirmation_token_sha256, link_token_sha256
        )
    ),
    CONSTRAINT campaign_poll_receipt_classification_shape CHECK (
        (classifier_status = 'ready'
            AND classifier_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
            AND methodology_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
            AND registry_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
            AND configuration_hash ~ '^[0-9a-f]{64}$')
        OR
        (classifier_status = 'unavailable'
            AND classification = 'unknown'
            AND upstream_classification = 'unknown'
            AND NOT explicit_browser_decision
            AND classifier_version IS NULL
            AND methodology_version IS NULL
            AND registry_version IS NULL
            AND configuration_hash IS NULL)
    ),
    CONSTRAINT campaign_poll_receipt_state_shape CHECK (
        (classification = 'human' AND initial_state = 'counted')
        OR (classification = 'machine' AND initial_state = 'machine_excluded')
        OR (classification = 'unknown' AND initial_state = 'unclassified_excluded')
    ),
    CONSTRAINT campaign_poll_receipt_browser_policy_shape CHECK (
        NOT explicit_browser_decision
        OR (
            classifier_status = 'ready'
            AND classification = 'human'
            AND upstream_classification = 'unknown'
            AND stable_reason = 'R_EXPLICIT_BROWSER_CONFIRMATION'
        )
    ),
    CONSTRAINT campaign_poll_receipt_submission_unique
        UNIQUE (tenant_id, poll_id, submission_key_sha256),
    CONSTRAINT campaign_poll_receipt_active_identity_unique
        UNIQUE (tenant_id, poll_id, option_id, id)
);

CREATE OR REPLACE FUNCTION enforce_campaign_poll_response_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    parent_poll campaign_polls%ROWTYPE;
BEGIN
    SELECT poll.*
      INTO parent_poll
      FROM campaign_polls AS poll
     WHERE poll.tenant_id = NEW.tenant_id
       AND poll.id = NEW.poll_id
       AND poll.content_revision_id = NEW.content_revision_id
       AND poll.token_version = 3
       AND poll.accepting_responses
     FOR SHARE;

    IF NOT FOUND
       OR parent_poll.content_revision_source_hash <> NEW.content_revision_source_hash
       OR parent_poll.poll_contract_sha256 <> NEW.poll_contract_sha256
       OR NOT EXISTS (
            SELECT 1
              FROM campaign_poll_options AS option
             WHERE option.tenant_id = NEW.tenant_id
               AND option.poll_id = NEW.poll_id
               AND option.id = NEW.option_id
       ) THEN
        RAISE EXCEPTION 'poll response receipt provenance is stale or invalid'
            USING ERRCODE = '23514';
    END IF;

    NEW.receipt_sha256 := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-poll-response-receipt.v1',
        'tenant_id', NEW.tenant_id,
        'poll_id', NEW.poll_id,
        'option_id', NEW.option_id,
        'content_revision_id', NEW.content_revision_id,
        'content_revision_source_hash', NEW.content_revision_source_hash,
        'poll_contract_sha256', NEW.poll_contract_sha256,
        'recipient_hash', NEW.recipient_hash,
        'link_token_sha256', NEW.link_token_sha256,
        'link_token_key_id', NEW.link_token_key_id,
        'token_issued_at', NEW.token_issued_at,
        'token_expires_at', NEW.token_expires_at,
        'confirmation_token_sha256', NEW.confirmation_token_sha256,
        'submission_key_sha256', NEW.submission_key_sha256,
        'initial_state', NEW.initial_state,
        'classification', NEW.classification,
        'upstream_classification', NEW.upstream_classification,
        'machine_subtype', NEW.machine_subtype,
        'stable_reason', NEW.stable_reason,
        'calibration_band', NEW.calibration_band,
        'classifier_version', NEW.classifier_version,
        'methodology_version', NEW.methodology_version,
        'registry_version', NEW.registry_version,
        'configuration_hash', NEW.configuration_hash,
        'classifier_status', NEW.classifier_status,
        'explicit_browser_decision', NEW.explicit_browser_decision,
        'evidence_sha256', NEW.evidence_sha256,
        'rules', NEW.rules,
        'conflicts', NEW.conflicts,
        'shadow_mode', NEW.shadow_mode,
        'confirmed_at', NEW.confirmed_at
    )::text, 'UTF8'), 'sha256'), 'hex');
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION campaign_poll_response_receipt_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'campaign poll response receipts are append-only'
        USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER campaign_poll_response_receipts_insert_guard
    BEFORE INSERT ON campaign_poll_response_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_campaign_poll_response_receipt();

CREATE TRIGGER campaign_poll_response_receipts_append_only
    BEFORE UPDATE OR DELETE ON campaign_poll_response_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_poll_response_receipt_append_only();

ALTER TABLE campaign_poll_response_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_poll_response_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_poll_response_receipts_tenant_select
    ON campaign_poll_response_receipts
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY campaign_poll_response_receipts_tenant_insert
    ON campaign_poll_response_receipts
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

REVOKE ALL ON campaign_poll_response_receipts FROM PUBLIC, postwave_app;
GRANT SELECT, INSERT ON campaign_poll_response_receipts TO postwave_app;

ALTER TABLE campaign_poll_responses
    ADD CONSTRAINT campaign_poll_responses_active_receipt_fk
        FOREIGN KEY (tenant_id, poll_id, option_id, active_receipt_id)
        REFERENCES campaign_poll_response_receipts (
            tenant_id, poll_id, option_id, id
        )
        ON DELETE RESTRICT
        NOT VALID;

ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_active_receipt_fk;

CREATE INDEX campaign_poll_receipts_recipient_time_idx
    ON campaign_poll_response_receipts (
        tenant_id, poll_id, recipient_hash, confirmed_at DESC, id
    );

COMMENT ON TABLE campaign_poll_response_receipts IS
    'Append-only F14 POST receipts with exact content revision, signing-key/timestamp provenance, and bounded F01 classifier evidence. campaign_poll_responses is only the mutable current-choice projection.';

COMMIT;
