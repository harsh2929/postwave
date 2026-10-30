-- 1927_seed_message_observations.sql
--
-- Append-only controlled-mailbox evidence for Inbox Reality. Placement remains
-- a mutable latest-value projection in seedlist_outcomes; this table records
-- every acquired message independently, with an exact gateway test/artifact
-- identity when one was issued. Raw RFC-822 bytes never enter PostgreSQL: the
-- service writes them to a private SSE-KMS object first and stores only the
-- opaque versioned reference, byte count, and digest here.
--
-- rollback-strategy: no-op. Observation and erasure receipts are evidence and
-- must outlive a deployment rollback. Older services ignore these tables.

BEGIN;

-- Complete the previously metadata-only Inbox Reality request with an optional
-- exact Campaign Assurance artifact bundle. Existing manual rows remain valid;
-- newly dispatched exact-artifact tests fill every member of the bundle.
ALTER TABLE inbox_reality_tests
    ADD COLUMN IF NOT EXISTS campaign_id uuid,
    ADD COLUMN IF NOT EXISTS content_revision_id uuid,
    ADD COLUMN IF NOT EXISTS send_plan_id uuid,
    ADD COLUMN IF NOT EXISTS artifact_id uuid,
    ADD COLUMN IF NOT EXISTS scenario_id text,
    ADD COLUMN IF NOT EXISTS outbound_mime_hash text,
    ADD COLUMN IF NOT EXISTS outbound_mime_structure_hash text,
    ADD COLUMN IF NOT EXISTS requested_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE inbox_reality_tests
    DROP CONSTRAINT IF EXISTS inbox_reality_tests_kind_check,
    ADD CONSTRAINT inbox_reality_tests_kind_check CHECK (
        kind IN ('manual', 'campaign_preview', 'mcp_tool', 'api', 'campaign_assurance')
    ),
    ADD CONSTRAINT inbox_reality_tests_requested_capabilities_object_check CHECK (
        jsonb_typeof(requested_capabilities) = 'object'
    ),
    ADD CONSTRAINT inbox_reality_tests_artifact_bundle_check CHECK (
        (
            campaign_id IS NULL
            AND content_revision_id IS NULL
            AND send_plan_id IS NULL
            AND artifact_id IS NULL
            AND scenario_id IS NULL
            AND outbound_mime_hash IS NULL
            AND outbound_mime_structure_hash IS NULL
        )
        OR
        (
            campaign_id IS NOT NULL
            AND content_revision_id IS NOT NULL
            AND send_plan_id IS NOT NULL
            AND artifact_id IS NOT NULL
            AND length(scenario_id) BETWEEN 1 AND 200
            AND outbound_mime_hash ~ '^[0-9a-f]{64}$'
            AND outbound_mime_structure_hash ~ '^[0-9a-f]{64}$'
        )
    );

ALTER TABLE inbox_reality_tests
    ADD CONSTRAINT inbox_reality_tests_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id),
    ADD CONSTRAINT inbox_reality_tests_revision_fk
        FOREIGN KEY (tenant_id, content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, id),
    ADD CONSTRAINT inbox_reality_tests_plan_fk
        FOREIGN KEY (tenant_id, send_plan_id)
        REFERENCES campaign_send_plans (tenant_id, id),
    ADD CONSTRAINT inbox_reality_tests_artifact_fk
        FOREIGN KEY (tenant_id, artifact_id)
        REFERENCES campaign_render_artifacts (tenant_id, id);

CREATE OR REPLACE FUNCTION inbox_reality_test_evidence_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.header_token IS DISTINCT FROM OLD.header_token
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.content_revision_id IS DISTINCT FROM OLD.content_revision_id
       OR NEW.send_plan_id IS DISTINCT FROM OLD.send_plan_id
       OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
       OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
       OR NEW.outbound_mime_hash IS DISTINCT FROM OLD.outbound_mime_hash
       OR NEW.outbound_mime_structure_hash IS DISTINCT FROM OLD.outbound_mime_structure_hash
       OR NEW.requested_capabilities IS DISTINCT FROM OLD.requested_capabilities
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'Inbox Reality test evidence identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER inbox_reality_test_evidence_identity_immutable
    BEFORE UPDATE ON inbox_reality_tests
    FOR EACH ROW EXECUTE FUNCTION inbox_reality_test_evidence_identity_immutable();

CREATE TABLE seed_message_observations (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    test_id                         uuid,
    campaign_id                     uuid,
    content_revision_id             uuid,
    send_plan_id                    uuid,
    artifact_id                     uuid,
    scenario_id                     text,
    test_token_sha256               text NOT NULL CHECK (test_token_sha256 ~ '^[0-9a-f]{64}$'),
    observation_key                 text NOT NULL CHECK (observation_key ~ '^[0-9a-f]{64}$'),

    mailbox_id                      text NOT NULL CHECK (length(mailbox_id) BETWEEN 1 AND 200),
    provider                        text NOT NULL CHECK (provider IN (
                                        'gmail', 'outlook_com', 'o365', 'icloud',
                                        'yahoo', 'proton', 'gmx', 'mailru'
                                    )),
    folder                          text NOT NULL CHECK (length(folder) BETWEEN 1 AND 500),
    labels                          jsonb NOT NULL DEFAULT '[]'::jsonb
                                    CHECK (jsonb_typeof(labels) = 'array'),
    placement                       text NOT NULL CHECK (placement IN (
                                        'primary', 'promotions', 'updates', 'social',
                                        'spam', 'blocked', 'missing'
                                    )),
    capability_snapshot             jsonb NOT NULL CHECK (jsonb_typeof(capability_snapshot) = 'object'),

    uid                             bigint,
    uid_validity                    bigint,
    provider_message_id_sha256      text CHECK (
                                        provider_message_id_sha256 IS NULL
                                        OR provider_message_id_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    provider_thread_id_sha256       text CHECK (
                                        provider_thread_id_sha256 IS NULL
                                        OR provider_thread_id_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    received_at                     timestamptz,
    checked_at                      timestamptz NOT NULL,

    raw_mime_status                 text NOT NULL CHECK (raw_mime_status IN (
                                        'complete', 'truncated', 'failed', 'unavailable'
                                    )),
    raw_mime_source                 text NOT NULL CHECK (length(raw_mime_source) BETWEEN 1 AND 80),
    raw_mime_error_code             text CHECK (
                                        raw_mime_error_code IS NULL
                                        OR raw_mime_error_code ~ '^[a-z][a-z0-9_]{0,95}$'
                                    ),
    raw_mime_sha256                 text CHECK (
                                        raw_mime_sha256 IS NULL
                                        OR raw_mime_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    raw_mime_captured_bytes         bigint NOT NULL DEFAULT 0 CHECK (raw_mime_captured_bytes >= 0),
    raw_mime_reported_bytes         bigint NOT NULL DEFAULT 0 CHECK (raw_mime_reported_bytes >= 0),
    raw_mime_max_bytes              bigint NOT NULL DEFAULT 0 CHECK (raw_mime_max_bytes >= 0),
    raw_mime_truncated              boolean NOT NULL DEFAULT false,
    raw_mime_object_ref             text CHECK (
                                        raw_mime_object_ref IS NULL
                                        OR (
                                            length(raw_mime_object_ref) BETWEEN 6 AND 2000
                                            AND raw_mime_object_ref ~ '^s3://[^[:space:]]+$'
                                        )
                                    ),
    raw_mime_object_version         text CHECK (
                                        raw_mime_object_version IS NULL
                                        OR length(raw_mime_object_version) BETWEEN 1 AND 1024
                                    ),
    parser_manifest                 jsonb NOT NULL CHECK (jsonb_typeof(parser_manifest) = 'object'),
    received_mime_structure_hash    text CHECK (
                                        received_mime_structure_hash IS NULL
                                        OR received_mime_structure_hash ~ '^[0-9a-f]{64}$'
                                    ),
    received_text_hash              text CHECK (
                                        received_text_hash IS NULL OR received_text_hash ~ '^[0-9a-f]{64}$'
                                    ),
    received_html_hash              text CHECK (
                                        received_html_hash IS NULL OR received_html_hash ~ '^[0-9a-f]{64}$'
                                    ),

    outbound_mime_hash              text CHECK (
                                        outbound_mime_hash IS NULL OR outbound_mime_hash ~ '^[0-9a-f]{64}$'
                                    ),
    outbound_mime_structure_hash    text CHECK (
                                        outbound_mime_structure_hash IS NULL
                                        OR outbound_mime_structure_hash ~ '^[0-9a-f]{64}$'
                                    ),
    outbound_text_hash              text CHECK (
                                        outbound_text_hash IS NULL OR outbound_text_hash ~ '^[0-9a-f]{64}$'
                                    ),
    outbound_html_hash              text CHECK (
                                        outbound_html_hash IS NULL OR outbound_html_hash ~ '^[0-9a-f]{64}$'
                                    ),
    structure_comparison            text NOT NULL DEFAULT 'unavailable' CHECK (
                                        structure_comparison IN ('match', 'mismatch', 'unavailable')
                                    ),
    text_comparison                 text NOT NULL DEFAULT 'unavailable' CHECK (
                                        text_comparison IN ('match', 'mismatch', 'unavailable')
                                    ),
    html_comparison                 text NOT NULL DEFAULT 'unavailable' CHECK (
                                        html_comparison IN ('match', 'mismatch', 'unavailable')
                                    ),
    comparison_manifest             jsonb NOT NULL DEFAULT '{}'::jsonb
                                    CHECK (jsonb_typeof(comparison_manifest) = 'object'),

    observed_surface_type           text CHECK (
                                        observed_surface_type IS NULL
                                        OR observed_surface_type IN (
                                            'list_preview', 'opened_thread_summary', 'search_overview',
                                            'ai_inbox_digest', 'highlight', 'promotion_annotation'
                                        )
                                    ),
    observed_summary_sha256         text CHECK (
                                        observed_summary_sha256 IS NULL
                                        OR observed_summary_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
    observed_summary_object_ref     text CHECK (
                                        observed_summary_object_ref IS NULL
                                        OR (
                                            length(observed_summary_object_ref) BETWEEN 6 AND 2000
                                            AND observed_summary_object_ref ~ '^s3://[^[:space:]]+$'
                                        )
                                    ),
    observed_environment            jsonb NOT NULL DEFAULT '{}'::jsonb
                                    CHECK (jsonb_typeof(observed_environment) = 'object'),
    observed_at                     timestamptz,

    source_class                    text NOT NULL DEFAULT 'controlled_seed' CHECK (
                                        source_class IN ('controlled_seed', 'controlled_client')
                                    ),
    capture_method                  text NOT NULL CHECK (length(capture_method) BETWEEN 1 AND 120),
    collection_version              text NOT NULL CHECK (length(collection_version) BETWEEN 1 AND 160),
    health_state                    text NOT NULL CHECK (
                                        health_state IN ('active', 'flagged', 'banned', 'unknown')
                                    ),
    error_codes                     jsonb NOT NULL DEFAULT '[]'::jsonb
                                    CHECK (jsonb_typeof(error_codes) = 'array'),
    captured_at                     timestamptz NOT NULL DEFAULT now(),
    expires_at                      timestamptz NOT NULL,

    CONSTRAINT seed_message_observations_test_fk
        FOREIGN KEY (test_id)
        REFERENCES inbox_reality_tests (id),
    CONSTRAINT seed_message_observations_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id),
    CONSTRAINT seed_message_observations_revision_fk
        FOREIGN KEY (tenant_id, content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, id),
    CONSTRAINT seed_message_observations_plan_fk
        FOREIGN KEY (tenant_id, send_plan_id)
        REFERENCES campaign_send_plans (tenant_id, id),
    CONSTRAINT seed_message_observations_artifact_fk
        FOREIGN KEY (tenant_id, artifact_id)
        REFERENCES campaign_render_artifacts (tenant_id, id),
    CONSTRAINT seed_message_observations_identity_check CHECK (
        test_id IS NOT NULL OR campaign_id IS NOT NULL
    ),
    CONSTRAINT seed_message_observations_artifact_bundle_check CHECK (
        (
            artifact_id IS NULL AND content_revision_id IS NULL AND send_plan_id IS NULL
            AND scenario_id IS NULL AND outbound_mime_hash IS NULL
            AND outbound_mime_structure_hash IS NULL
            AND outbound_text_hash IS NULL AND outbound_html_hash IS NULL
        )
        OR
        (
            artifact_id IS NOT NULL AND campaign_id IS NOT NULL
            AND content_revision_id IS NOT NULL AND send_plan_id IS NOT NULL
            AND length(scenario_id) BETWEEN 1 AND 200
            AND outbound_mime_hash IS NOT NULL
            AND outbound_mime_structure_hash IS NOT NULL
            AND outbound_text_hash IS NOT NULL AND outbound_html_hash IS NOT NULL
        )
    ),
    CONSTRAINT seed_message_observations_uid_check CHECK (
        (uid IS NULL AND uid_validity IS NULL)
        OR (uid BETWEEN 1 AND 4294967295 AND uid_validity BETWEEN 1 AND 4294967295)
    ),
    CONSTRAINT seed_message_observations_raw_mime_shape_check CHECK (
        (
            raw_mime_status = 'complete'
            AND raw_mime_truncated = false
            AND raw_mime_sha256 IS NOT NULL
            AND raw_mime_captured_bytes > 0
            AND raw_mime_object_ref IS NOT NULL
        )
        OR
        (
            raw_mime_status = 'truncated'
            AND raw_mime_truncated = true
            AND raw_mime_sha256 IS NOT NULL
            AND raw_mime_captured_bytes > 0
            AND raw_mime_object_ref IS NOT NULL
        )
        OR
        (
            raw_mime_status IN ('failed', 'unavailable')
            AND raw_mime_sha256 IS NULL
            AND raw_mime_captured_bytes = 0
            AND raw_mime_object_ref IS NULL
            AND raw_mime_object_version IS NULL
        )
    ),
    CONSTRAINT seed_message_observations_object_version_check CHECK (
        raw_mime_object_version IS NULL OR raw_mime_object_ref IS NOT NULL
    ),
    CONSTRAINT seed_message_observations_comparison_shape_check CHECK (
        (
            (outbound_mime_structure_hash IS NULL OR received_mime_structure_hash IS NULL)
            AND structure_comparison = 'unavailable'
        )
        OR (
            outbound_mime_structure_hash IS NOT NULL
            AND received_mime_structure_hash IS NOT NULL
            AND (
                (outbound_mime_structure_hash = received_mime_structure_hash AND structure_comparison = 'match')
                OR
                (outbound_mime_structure_hash <> received_mime_structure_hash AND structure_comparison = 'mismatch')
            )
        )
    ),
    CONSTRAINT seed_message_observations_text_comparison_shape_check CHECK (
        (
            (outbound_text_hash IS NULL OR received_text_hash IS NULL)
            AND text_comparison = 'unavailable'
        )
        OR (
            outbound_text_hash IS NOT NULL AND received_text_hash IS NOT NULL
            AND (
                (outbound_text_hash = received_text_hash AND text_comparison = 'match')
                OR (outbound_text_hash <> received_text_hash AND text_comparison = 'mismatch')
            )
        )
    ),
    CONSTRAINT seed_message_observations_html_comparison_shape_check CHECK (
        (
            (outbound_html_hash IS NULL OR received_html_hash IS NULL)
            AND html_comparison = 'unavailable'
        )
        OR (
            outbound_html_hash IS NOT NULL AND received_html_hash IS NOT NULL
            AND (
                (outbound_html_hash = received_html_hash AND html_comparison = 'match')
                OR (outbound_html_hash <> received_html_hash AND html_comparison = 'mismatch')
            )
        )
    ),
    CONSTRAINT seed_message_observations_observed_surface_shape_check CHECK (
        (
            observed_surface_type IS NULL
            AND observed_summary_sha256 IS NULL
            AND observed_summary_object_ref IS NULL
            AND observed_at IS NULL
            AND observed_environment = '{}'::jsonb
        )
        OR
        (
            observed_surface_type IS NOT NULL
            AND observed_summary_sha256 IS NOT NULL
            AND observed_summary_object_ref IS NOT NULL
            AND observed_at IS NOT NULL
            AND observed_environment <> '{}'::jsonb
            AND source_class = 'controlled_client'
        )
    ),
    CONSTRAINT seed_message_observations_time_check CHECK (
        expires_at > captured_at
        AND checked_at <= captured_at + interval '5 minutes'
        AND (received_at IS NULL OR received_at <= captured_at + interval '5 minutes')
        AND (observed_at IS NULL OR observed_at <= captured_at + interval '5 minutes')
    ),
    UNIQUE (tenant_id, observation_key),
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX seed_message_observations_uid_idempotency_uidx
    ON seed_message_observations (
        tenant_id, mailbox_id, folder, uid_validity, uid, collection_version
    )
    WHERE uid IS NOT NULL;

CREATE INDEX seed_message_observations_test_created_idx
    ON seed_message_observations (tenant_id, test_id, captured_at, id)
    WHERE test_id IS NOT NULL;
CREATE INDEX seed_message_observations_campaign_created_idx
    ON seed_message_observations (tenant_id, campaign_id, captured_at DESC, id DESC)
    WHERE campaign_id IS NOT NULL;
CREATE INDEX seed_message_observations_artifact_idx
    ON seed_message_observations (tenant_id, artifact_id, captured_at, id)
    WHERE artifact_id IS NOT NULL;
CREATE INDEX seed_message_observations_retention_idx
    ON seed_message_observations (expires_at, id)
    WHERE raw_mime_object_ref IS NOT NULL;

-- Reject any test/artifact identity drift even if an application accidentally
-- combines independently valid IDs. The writer must present the exact frozen
-- bundle; the trigger never fills in missing evidence on its behalf.
CREATE OR REPLACE FUNCTION seed_message_observation_validate_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    test_row record;
    artifact_row record;
BEGIN
    IF NEW.test_id IS NOT NULL THEN
        SELECT campaign_id, content_revision_id, send_plan_id, artifact_id,
               scenario_id, outbound_mime_hash, outbound_mime_structure_hash
          INTO STRICT test_row
          FROM public.inbox_reality_tests
         WHERE tenant_id = NEW.tenant_id AND id = NEW.test_id;

        IF test_row.artifact_id IS NOT NULL AND (
            NEW.campaign_id IS DISTINCT FROM test_row.campaign_id
            OR NEW.content_revision_id IS DISTINCT FROM test_row.content_revision_id
            OR NEW.send_plan_id IS DISTINCT FROM test_row.send_plan_id
            OR NEW.artifact_id IS DISTINCT FROM test_row.artifact_id
            OR NEW.scenario_id IS DISTINCT FROM test_row.scenario_id
            OR NEW.outbound_mime_hash IS DISTINCT FROM test_row.outbound_mime_hash
            OR NEW.outbound_mime_structure_hash IS DISTINCT FROM test_row.outbound_mime_structure_hash
        ) THEN
            RAISE EXCEPTION 'seed observation does not match gateway test artifact identity'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.artifact_id IS NOT NULL THEN
        SELECT a.campaign_id, p.content_revision_id, a.send_plan_id, a.scenario_id,
               a.outbound_mime_hash, a.mime_structure_hash, a.text_hash, a.html_hash
          INTO STRICT artifact_row
          FROM public.campaign_render_artifacts a
          JOIN public.campaign_send_plans p
            ON p.tenant_id = a.tenant_id AND p.id = a.send_plan_id
         WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.artifact_id;

        IF NEW.campaign_id IS DISTINCT FROM artifact_row.campaign_id
           OR NEW.content_revision_id IS DISTINCT FROM artifact_row.content_revision_id
           OR NEW.send_plan_id IS DISTINCT FROM artifact_row.send_plan_id
           OR NEW.scenario_id IS DISTINCT FROM artifact_row.scenario_id
           OR NEW.outbound_mime_hash IS DISTINCT FROM artifact_row.outbound_mime_hash
           OR NEW.outbound_mime_structure_hash IS DISTINCT FROM artifact_row.mime_structure_hash
           OR NEW.outbound_text_hash IS DISTINCT FROM artifact_row.text_hash
           OR NEW.outbound_html_hash IS DISTINCT FROM artifact_row.html_hash THEN
            RAISE EXCEPTION 'seed observation does not match immutable render artifact'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER seed_message_observations_validate_identity
    BEFORE INSERT ON seed_message_observations
    FOR EACH ROW EXECUTE FUNCTION seed_message_observation_validate_identity();

CREATE OR REPLACE FUNCTION seed_message_observations_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        -- Permit only a referential-action cascade (tenant/campaign/test
        -- erasure). A direct application DELETE enters at depth 1.
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'seed_message_observations is append-only'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER seed_message_observations_append_only
    BEFORE UPDATE OR DELETE ON seed_message_observations
    FOR EACH ROW EXECUTE FUNCTION seed_message_observations_append_only();

-- Object deletion is a separate immutable receipt. The observation keeps its
-- historical reference/hash after the short-lived payload has been erased.
CREATE TABLE seed_observation_object_deletions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    observation_id      uuid NOT NULL,
    object_kind         text NOT NULL CHECK (object_kind IN ('received_mime', 'observed_summary')),
    object_ref_sha256   text NOT NULL CHECK (object_ref_sha256 ~ '^[0-9a-f]{64}$'),
    reason              text NOT NULL CHECK (reason IN ('retention', 'tenant_erasure', 'crypto_shred', 'manual_security')),
    deletion_receipt    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(deletion_receipt) = 'object'),
    deleted_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT seed_observation_object_deletions_observation_fk
        FOREIGN KEY (tenant_id, observation_id)
        REFERENCES seed_message_observations (tenant_id, id)
        ON DELETE CASCADE,
    UNIQUE (tenant_id, observation_id, object_kind),
    UNIQUE (tenant_id, id)
);

CREATE OR REPLACE FUNCTION seed_observation_object_deletions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'seed observation deletion receipts are append-only'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER seed_observation_object_deletions_append_only
    BEFORE UPDATE OR DELETE ON seed_observation_object_deletions
    FOR EACH ROW EXECUTE FUNCTION seed_observation_object_deletions_append_only();

-- Durable per-folder cursors prevent process restarts and date-granularity IMAP
-- searches from losing or repeatedly downloading observations. This contains
-- only operational seed IDs, never addresses or credentials.
CREATE TABLE seed_mailbox_capture_cursors (
    mailbox_id       text NOT NULL CHECK (length(mailbox_id) BETWEEN 1 AND 200),
    folder           text NOT NULL CHECK (length(folder) BETWEEN 1 AND 500),
    uid_validity     bigint NOT NULL CHECK (uid_validity BETWEEN 1 AND 4294967295),
    last_uid         bigint NOT NULL CHECK (last_uid BETWEEN 0 AND 4294967295),
    generation       bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    last_seen_at     timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mailbox_id, folder)
);

CREATE OR REPLACE FUNCTION seed_mailbox_capture_cursor_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
       OR NEW.folder IS DISTINCT FROM OLD.folder THEN
        RAISE EXCEPTION 'seed mailbox cursor identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'seed mailbox cursor time cannot regress'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.uid_validity = OLD.uid_validity THEN
        IF NEW.last_uid < OLD.last_uid OR NEW.generation <> OLD.generation THEN
            RAISE EXCEPTION 'seed mailbox cursor cannot regress within one UIDVALIDITY generation'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'seed mailbox UIDVALIDITY reset must advance generation exactly once'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER seed_mailbox_capture_cursor_monotonic
    BEFORE UPDATE ON seed_mailbox_capture_cursors
    FOR EACH ROW EXECUTE FUNCTION seed_mailbox_capture_cursor_monotonic();

CREATE TABLE seed_mailbox_capture_cursor_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id       text NOT NULL CHECK (length(mailbox_id) BETWEEN 1 AND 200),
    folder           text NOT NULL CHECK (length(folder) BETWEEN 1 AND 500),
    event_type       text NOT NULL CHECK (event_type IN ('created', 'advanced', 'uidvalidity_reset')),
    prior_uid_validity bigint,
    uid_validity     bigint NOT NULL CHECK (uid_validity BETWEEN 1 AND 4294967295),
    prior_last_uid   bigint,
    last_uid         bigint NOT NULL CHECK (last_uid BETWEEN 0 AND 4294967295),
    generation       bigint NOT NULL CHECK (generation > 0),
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT seed_mailbox_capture_cursor_events_shape_check CHECK (
        (
            event_type = 'created'
            AND prior_uid_validity IS NULL AND prior_last_uid IS NULL
            AND generation = 1
        )
        OR
        (
            event_type = 'advanced'
            AND prior_uid_validity = uid_validity
            AND prior_last_uid IS NOT NULL AND last_uid > prior_last_uid
        )
        OR
        (
            event_type = 'uidvalidity_reset'
            AND prior_uid_validity IS NOT NULL AND prior_uid_validity <> uid_validity
            AND prior_last_uid IS NOT NULL
        )
    )
);

CREATE INDEX seed_mailbox_capture_cursor_events_mailbox_idx
    ON seed_mailbox_capture_cursor_events (mailbox_id, folder, recorded_at DESC, id DESC);

CREATE OR REPLACE FUNCTION seed_mailbox_capture_cursor_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    RAISE EXCEPTION 'seed mailbox cursor events are append-only'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER seed_mailbox_capture_cursor_events_append_only
    BEFORE UPDATE OR DELETE ON seed_mailbox_capture_cursor_events
    FOR EACH ROW EXECUTE FUNCTION seed_mailbox_capture_cursor_events_append_only();

COMMENT ON TABLE seed_message_observations IS
    'Append-only controlled mailbox placement and received-MIME evidence; never a recipient-wide provider claim.';
COMMENT ON COLUMN seed_message_observations.raw_mime_object_ref IS
    'Private versioned SSE-KMS object reference; RFC-822 bytes are never stored in PostgreSQL.';
COMMENT ON COLUMN seed_message_observations.source_class IS
    'controlled_seed is placement/MIME evidence; controlled_client is a named observed UI environment.';

GRANT SELECT, INSERT ON seed_message_observations TO postwave_app;
GRANT SELECT, INSERT ON seed_observation_object_deletions TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON seed_mailbox_capture_cursors TO postwave_app;
GRANT SELECT, INSERT ON seed_mailbox_capture_cursor_events TO postwave_app;

ALTER TABLE seed_message_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_message_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE seed_observation_object_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_observation_object_deletions FORCE ROW LEVEL SECURITY;
ALTER TABLE seed_mailbox_capture_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_mailbox_capture_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE seed_mailbox_capture_cursor_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_mailbox_capture_cursor_events FORCE ROW LEVEL SECURITY;

CREATE POLICY seed_message_observations_tenant_select
    ON seed_message_observations FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY seed_message_observations_tenant_insert
    ON seed_message_observations FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY seed_message_observations_retention_select
    ON seed_message_observations FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.seed_observation_retention_worker', true) = 'true'
    );

CREATE POLICY seed_observation_object_deletions_tenant_select
    ON seed_observation_object_deletions FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY seed_observation_object_deletions_retention_select
    ON seed_observation_object_deletions FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.seed_observation_retention_worker', true) = 'true'
    );
CREATE POLICY seed_observation_object_deletions_retention_insert
    ON seed_observation_object_deletions FOR INSERT TO postwave_app
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.seed_observation_retention_worker', true) = 'true'
    );

CREATE POLICY seed_mailbox_capture_cursors_worker_all
    ON seed_mailbox_capture_cursors FOR ALL TO postwave_app
    USING (current_setting('app.seed_observation_worker', true) = 'true')
    WITH CHECK (current_setting('app.seed_observation_worker', true) = 'true');
CREATE POLICY seed_mailbox_capture_cursor_events_worker_select
    ON seed_mailbox_capture_cursor_events FOR SELECT TO postwave_app
    USING (current_setting('app.seed_observation_worker', true) = 'true');
CREATE POLICY seed_mailbox_capture_cursor_events_worker_insert
    ON seed_mailbox_capture_cursor_events FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.seed_observation_worker', true) = 'true');

COMMIT;
