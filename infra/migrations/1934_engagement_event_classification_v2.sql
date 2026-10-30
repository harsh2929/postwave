-- 1934_engagement_event_classification_v2.sql
--
-- Track B F01: immutable source observations and versioned, explainable
-- human/machine/unknown classifications over the canonical subscriber_events
-- ledger.  Classifications are append-only, so a methodology upgrade creates
-- auditable history instead of rewriting yesterday's engagement numbers.
--
-- The customer-facing projection is intentionally shadow-only.  An absent or
-- unknown classification produces human_signal=false and unknown_signal=true;
-- no compatibility consumer can silently turn uncertainty into a human open.
--
-- rollback-strategy: no-op. Observation hashes, classifications, calibration
-- receipts, and reclassification lineage are measurement evidence. Older
-- binaries ignore these additive tables and the shadow view.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- subscriber_events is range-partitioned by at and its primary key is (id, at).
-- A unique index that adds tenant_id on the populated partitioned parent cannot
-- be built CONCURRENTLY. Use a narrow tenant-identity bridge instead: its
-- (event_id, at) FK targets the existing primary key, while every F01 evidence
-- row has a composite tenant FK to this bridge. The canonical-binding trigger
-- creates the identity only after proving the tenant on subscriber_events.
CREATE TABLE subscriber_event_engagement_identities (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_event_id bigint NOT NULL,
    subscriber_event_at timestamptz NOT NULL,
    recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (tenant_id, subscriber_event_id, subscriber_event_at),
    CONSTRAINT subscriber_event_engagement_identities_event_fk
        FOREIGN KEY (subscriber_event_id, subscriber_event_at)
        REFERENCES subscriber_events (id, at)
        ON DELETE CASCADE
);

CREATE TABLE engagement_machine_registry_entries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registry_version    text NOT NULL CHECK (
                            registry_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                        ),
    entry_id            text NOT NULL CHECK (
                            entry_id ~ '^[A-Z][A-Z0-9_]{2,95}$'
                        ),
    matcher_type        text NOT NULL CHECK (matcher_type IN (
                            'asn', 'cidr', 'ua_substring', 'ua_regex',
                            'reverse_dns_suffix', 'provider_flag', 'source'
                        )),
    matcher_value       text NOT NULL CHECK (
                            length(matcher_value) BETWEEN 1 AND 1000
                            AND matcher_value !~ '[[:cntrl:]]'
                        ),
    machine_subtype     text NOT NULL CHECK (machine_subtype IN (
                            'apple_mpp', 'gmail_proxy', 'outlook_safelinks',
                            'seg_scanner', 'prefetcher', 'seed_automation',
                            'link_checker', 'ai_summarizer', 'unknown_bot'
                        )),
    confidence          numeric(5,4) NOT NULL CHECK (
                            confidence >= 0 AND confidence <= 1
                        ),
    source_note         text NOT NULL CHECK (
                            length(source_note) BETWEEN 1 AND 2000
                        ),
    last_verified       date NOT NULL,
    recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    entry_fingerprint   text NOT NULL CHECK (
                            entry_fingerprint ~ '^[0-9a-f]{64}$'
                        ),

    UNIQUE (registry_version, entry_id),
    UNIQUE (registry_version, entry_fingerprint)
);

CREATE INDEX engagement_machine_registry_lookup_idx
    ON engagement_machine_registry_entries (
        registry_version, matcher_type, machine_subtype, entry_id
    );

-- Conservative bootstrap signals migrate the repository's existing binary
-- UA knowledge into data. They remain shadow-only until a calibration receipt
-- has both controlled-machine and labeled-human corpora. ai_summarizer is a
-- supported subtype but intentionally has no rule until validated evidence is
-- publishable; guessing would collapse it into machine traffic dishonestly.
WITH bootstrap(
    entry_id, matcher_type, matcher_value, machine_subtype,
    confidence, source_note
) AS (VALUES
    ('R_APPLE_MPP_UA', 'ua_regex',
     '(?i)(applemail/mpp|apple-mail-mpp|mail-privacy-proxy)',
     'apple_mpp', 0.9900::numeric,
     'Migrated from the existing MPP classifier; shadow-only pending F01 calibration.'),
    ('R_GMAIL_PROXY_UA', 'ua_substring', 'googleimageproxy',
     'gmail_proxy', 0.9900::numeric,
     'Migrated from the existing proxy classifier; shadow-only pending F01 calibration.'),
    ('R_OUTLOOK_SAFELINKS_UA', 'ua_regex',
     '(?i)(outlook-safelinks|outlook safelinks)',
     'outlook_safelinks', 0.9900::numeric,
     'Migrated from the existing SafeLinks classifier; shadow-only pending F01 calibration.'),
    ('R_SEG_SCANNER_UA', 'ua_regex',
     '(?i)(proofpoint|mimecast|barracuda)',
     'seg_scanner', 0.9700::numeric,
     'Migrated from the existing SEG signatures; shadow-only pending F01 calibration.'),
    ('R_LINK_CHECKER_UA', 'ua_regex',
     '(?i)(headlesschrome|linkchecker)',
     'link_checker', 0.9000::numeric,
     'Conservative headless/link-checker signature; shadow-only pending F01 calibration.'),
    ('R_PROVIDER_MACHINE_FLAG', 'provider_flag', 'sg_machine_open',
     'unknown_bot', 0.9950::numeric,
     'Explicit provider machine-open flag; shadow-only pending cross-provider calibration.')
)
INSERT INTO engagement_machine_registry_entries (
    registry_version, entry_id, matcher_type, matcher_value,
    machine_subtype, confidence, source_note, last_verified,
    entry_fingerprint
)
SELECT
    'postwave.machine-source-registry.v1', entry_id, matcher_type,
    matcher_value, machine_subtype, confidence, source_note,
    DATE '2026-08-10',
    encode(digest(convert_to(concat_ws(E'\x1f',
        'postwave.machine-source-registry.v1', entry_id, matcher_type,
        matcher_value, machine_subtype, confidence::float8::text, source_note,
        '2026-08-10'
    ), 'UTF8'), 'sha256'), 'hex')
FROM bootstrap;

CREATE TABLE engagement_classifier_methodology_versions (
    classifier_version  text NOT NULL CHECK (
                            classifier_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                        ),
    methodology_version text NOT NULL CHECK (
                            methodology_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                        ),
    registry_version    text NOT NULL CHECK (
                            registry_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                        ),
    configuration_hash  text NOT NULL CHECK (
                            configuration_hash ~ '^[0-9a-f]{64}$'
                        ),
    rollout_mode        text NOT NULL CHECK (rollout_mode IN (
                            'shadow', 'calibration', 'authoritative'
                        )),
    configuration       jsonb NOT NULL CHECK (
                            jsonb_typeof(configuration) = 'object'
                            AND octet_length(configuration::text) <= 32768
                        ),
    release_note        text NOT NULL CHECK (
                            length(release_note) BETWEEN 1 AND 4000
                        ),
    recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (
        classifier_version, methodology_version,
        registry_version, configuration_hash
    )
);

CREATE TABLE subscriber_event_observations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_event_id      bigint NOT NULL,
    subscriber_event_at      timestamptz NOT NULL,
    source                   text NOT NULL CHECK (
                                 source ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                             ),
    source_event_id          text CHECK (
                                 source_event_id IS NULL OR
                                 length(source_event_id) BETWEEN 1 AND 500
                             ),
    idempotency_key          text NOT NULL CHECK (
                                 length(idempotency_key) BETWEEN 1 AND 500
                                 AND idempotency_key !~ '[[:cntrl:]]'
                             ),
    event_schema_version     text NOT NULL CHECK (
                                 event_schema_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                             ),
    event_type               text NOT NULL CHECK (
                                 event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'
                             ),
    occurred_at              timestamptz NOT NULL,
    ingested_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at             timestamptz,
    campaign_id              uuid,

    recipient_identity_hmac  text CHECK (
                                 recipient_identity_hmac IS NULL OR
                                 recipient_identity_hmac ~ '^[0-9a-f]{64}$'
                             ),
    recipient_key_id         text CHECK (
                                 recipient_key_id IS NULL OR
                                 recipient_key_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$'
                             ),
    message_identity_hash    text CHECK (
                                 message_identity_hash IS NULL OR
                                 message_identity_hash ~ '^[0-9a-f]{64}$'
                             ),
    link_identity_hash       text CHECK (
                                 link_identity_hash IS NULL OR
                                 link_identity_hash ~ '^[0-9a-f]{64}$'
                             ),
    is_seed                  boolean NOT NULL DEFAULT false,
    seed_test_id             uuid,
    provider_message_id      text CHECK (
                                 provider_message_id IS NULL OR
                                 length(provider_message_id) BETWEEN 1 AND 500
                             ),
    provider_request_id      text CHECK (
                                 provider_request_id IS NULL OR
                                 length(provider_request_id) BETWEEN 1 AND 500
                             ),

    ordered_headers          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
                                 jsonb_typeof(ordered_headers) = 'array'
                                 AND octet_length(ordered_headers::text) <= 32768
                             ),
    ordered_headers_complete boolean NOT NULL DEFAULT false,
    user_agent               text CHECK (
                                 user_agent IS NULL OR length(user_agent) <= 4096
                             ),
    ip_address               inet,
    network_asn              bigint CHECK (
                                 network_asn IS NULL OR
                                 network_asn BETWEEN 1 AND 4294967295
                             ),
    network_region           text CHECK (
                                 network_region IS NULL OR
                                 length(network_region) BETWEEN 1 AND 160
                             ),
    reverse_dns              text CHECK (
                                 reverse_dns IS NULL OR
                                 length(reverse_dns) BETWEEN 1 AND 253
                             ),
    tls_ja4                  text CHECK (
                                 tls_ja4 IS NULL OR
                                 tls_ja4 ~ '^[A-Za-z0-9_+-]{8,255}$'
                             ),
    provider_signals         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                                 jsonb_typeof(provider_signals) = 'object'
                                 AND octet_length(provider_signals::text) <= 16384
                             ),
    dwell_milliseconds       bigint CHECK (
                                 dwell_milliseconds IS NULL OR
                                 dwell_milliseconds BETWEEN 0 AND 86400000
                             ),
    message_link_count       integer CHECK (
                                 message_link_count IS NULL OR
                                 message_link_count BETWEEN 0 AND 10000
                             ),
    body_hash                text CHECK (
                                 body_hash IS NULL OR body_hash ~ '^[0-9a-f]{64}$'
                             ),
    raw_object_ref           text CHECK (
                                 raw_object_ref IS NULL OR (
                                     length(raw_object_ref) BETWEEN 1 AND 2000
                                     AND raw_object_ref !~ '[[:cntrl:]]'
                                 )
                             ),
    raw_object_version_id    text CHECK (
                                 raw_object_version_id IS NULL OR
                                 length(raw_object_version_id) BETWEEN 1 AND 1000
                             ),
    privacy_expiry_at        timestamptz NOT NULL,
    observation_fingerprint text NOT NULL CHECK (
                                 observation_fingerprint ~ '^[0-9a-f]{64}$'
                             ),

    CONSTRAINT subscriber_event_observations_event_fk
        FOREIGN KEY (tenant_id, subscriber_event_id, subscriber_event_at)
        REFERENCES subscriber_event_engagement_identities (
            tenant_id, subscriber_event_id, subscriber_event_at
        )
        ON DELETE CASCADE,
    CONSTRAINT subscriber_event_observations_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT subscriber_event_observations_recipient_identity_shape CHECK (
        (recipient_identity_hmac IS NULL AND recipient_key_id IS NULL)
        OR
        (recipient_identity_hmac IS NOT NULL AND recipient_key_id IS NOT NULL)
    ),
    CONSTRAINT subscriber_event_observations_raw_object_shape CHECK (
        (raw_object_ref IS NULL AND raw_object_version_id IS NULL)
        OR raw_object_ref IS NOT NULL
    ),
    UNIQUE (tenant_id, source, idempotency_key),
    UNIQUE (tenant_id, id)
);

CREATE INDEX subscriber_event_observations_event_idx
    ON subscriber_event_observations (
        tenant_id, subscriber_event_at, subscriber_event_id, occurred_at, id
    );
CREATE INDEX subscriber_event_observations_message_idx
    ON subscriber_event_observations (
        tenant_id, message_identity_hash, occurred_at, id
    ) WHERE message_identity_hash IS NOT NULL;
CREATE INDEX subscriber_event_observations_expiry_idx
    ON subscriber_event_observations (privacy_expiry_at, id);

-- Origin and canonical dimensions are never accepted from an adapter. The
-- normalized subscriber_events row is the authority, including the
-- controlled-seed identity derived by migration 1930.
CREATE OR REPLACE FUNCTION subscriber_event_observation_bind_canonical_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    canonical_event_type text;
    canonical_campaign_id uuid;
    canonical_is_seed boolean;
    canonical_seed_test_id uuid;
BEGIN
    SELECT event.event_type, event.campaign_id, event.is_seed,
           event.controlled_seed_test_id
      INTO canonical_event_type, canonical_campaign_id,
           canonical_is_seed, canonical_seed_test_id
      FROM public.subscriber_events AS event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.id = NEW.subscriber_event_id
       AND event.at = NEW.subscriber_event_at;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'canonical subscriber event does not exist'
            USING ERRCODE = '23503';
    END IF;
    NEW.event_type := canonical_event_type;
    NEW.campaign_id := canonical_campaign_id;
    NEW.is_seed := canonical_is_seed;
    NEW.seed_test_id := canonical_seed_test_id;
    INSERT INTO public.subscriber_event_engagement_identities (
        tenant_id, subscriber_event_id, subscriber_event_at
    ) VALUES (
        NEW.tenant_id, NEW.subscriber_event_id, NEW.subscriber_event_at
    ) ON CONFLICT (
        tenant_id, subscriber_event_id, subscriber_event_at
    ) DO NOTHING;
    RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION subscriber_event_observation_bind_canonical_event()
    FROM PUBLIC, postwave_app;

CREATE TRIGGER subscriber_event_observations_bind_canonical_event
    BEFORE INSERT ON subscriber_event_observations
    FOR EACH ROW EXECUTE FUNCTION subscriber_event_observation_bind_canonical_event();

CREATE TABLE event_reclassification_runs (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_id               uuid NOT NULL,
    request_hash             text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    event_window_start       timestamptz NOT NULL,
    event_window_end         timestamptz NOT NULL,
    classifier_version       text NOT NULL,
    methodology_version      text NOT NULL,
    registry_version         text NOT NULL,
    configuration_hash       text NOT NULL CHECK (
                                 configuration_hash ~ '^[0-9a-f]{64}$'
                             ),
    state                    text NOT NULL DEFAULT 'queued' CHECK (
                                 state IN ('queued', 'running', 'completed', 'failed')
                             ),
    worker_id                text CHECK (
                                 worker_id IS NULL OR (
                                     length(worker_id) BETWEEN 1 AND 200
                                     AND worker_id !~ '[[:cntrl:]]'
                                 )
                             ),
    lease_token              uuid,
    lease_expires_at         timestamptz,
    heartbeat_at             timestamptz,
    attempt_count            integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    cursor_event_at          timestamptz,
    cursor_event_id          bigint,
    candidate_count          bigint NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    classified_count         bigint NOT NULL DEFAULT 0 CHECK (classified_count >= 0),
    unchanged_count          bigint NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
    error_count              bigint NOT NULL DEFAULT 0 CHECK (error_count >= 0),
    error_code               text CHECK (
                                 error_code IS NULL OR
                                 error_code ~ '^[a-z][a-z0-9_.-]{0,95}$'
                             ),
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at               timestamptz,
    completed_at             timestamptz,
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT event_reclassification_runs_window_check CHECK (
        event_window_end > event_window_start
    ),
    CONSTRAINT event_reclassification_runs_cursor_shape CHECK (
        (cursor_event_at IS NULL) = (cursor_event_id IS NULL)
    ),
    CONSTRAINT event_reclassification_runs_counter_shape CHECK (
        classified_count + unchanged_count <= candidate_count
        AND (state <> 'completed' OR (
            classified_count + unchanged_count = candidate_count
            AND error_count = 0
        ))
    ),
    CONSTRAINT event_reclassification_runs_terminal_shape CHECK (
        (state = 'queued' AND started_at IS NULL AND completed_at IS NULL
            AND error_code IS NULL AND worker_id IS NULL AND lease_token IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND attempt_count = 0)
        OR
        (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL
            AND error_code IS NULL AND worker_id IS NOT NULL
            AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
            AND heartbeat_at IS NOT NULL AND lease_expires_at > heartbeat_at
            AND attempt_count > 0)
        OR
        (state = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND error_code IS NULL AND worker_id IS NOT NULL
            AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
            AND heartbeat_at IS NOT NULL AND attempt_count > 0)
        OR
        (state = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND error_code IS NOT NULL AND worker_id IS NOT NULL
            AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
            AND heartbeat_at IS NOT NULL AND attempt_count > 0)
    ),
    UNIQUE (tenant_id, request_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX event_reclassification_runs_state_idx
    ON event_reclassification_runs (
        state, lease_expires_at, updated_at, id
    );

CREATE TABLE event_classifications (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_event_id      bigint NOT NULL,
    subscriber_event_at      timestamptz NOT NULL,
    classification           text NOT NULL CHECK (
                                 classification IN ('human', 'machine', 'unknown')
                             ),
    machine_subtype          text CHECK (
                                 machine_subtype IS NULL OR machine_subtype IN (
                                     'apple_mpp', 'gmail_proxy', 'outlook_safelinks',
                                     'seg_scanner', 'prefetcher', 'seed_automation',
                                     'link_checker', 'ai_summarizer', 'unknown_bot'
                                 )
                             ),
    human_confidence         numeric(5,4) NOT NULL CHECK (
                                 human_confidence >= 0 AND human_confidence <= 1
                             ),
    calibration_band         text NOT NULL CHECK (
                                 calibration_band IN (
                                     'deterministic_machine', 'likely_machine',
                                     'ambiguous', 'likely_human', 'calibrated_human'
                                 )
                             ),
    stable_reason            text NOT NULL CHECK (
                                 stable_reason ~ '^R_[A-Z0-9_]{2,95}$'
                             ),
    rules_fired              text[] NOT NULL CHECK (
                                 cardinality(rules_fired) BETWEEN 1 AND 128
                             ),
    evidence                 jsonb NOT NULL CHECK (
                                 jsonb_typeof(evidence) = 'array'
                                 AND jsonb_array_length(evidence) >= 1
                                 AND octet_length(evidence::text) <= 65536
                             ),
    conflicts                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
                                 jsonb_typeof(conflicts) = 'array'
                                 AND octet_length(conflicts::text) <= 32768
                             ),
    observation_ids          uuid[] NOT NULL CHECK (
                                 cardinality(observation_ids) BETWEEN 1 AND 256
                             ),
    classifier_version       text NOT NULL,
    methodology_version      text NOT NULL,
    registry_version         text NOT NULL,
    configuration_hash       text NOT NULL CHECK (
                                 configuration_hash ~ '^[0-9a-f]{64}$'
                             ),
    shadow_mode              boolean NOT NULL DEFAULT true,
    supersedes_id            uuid,
    reclassification_run_id  uuid,
    classified_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    classification_fingerprint text NOT NULL CHECK (
                                 classification_fingerprint ~ '^[0-9a-f]{64}$'
                             ),

    CONSTRAINT event_classifications_event_fk
        FOREIGN KEY (tenant_id, subscriber_event_id, subscriber_event_at)
        REFERENCES subscriber_event_engagement_identities (
            tenant_id, subscriber_event_id, subscriber_event_at
        )
        ON DELETE CASCADE,
    CONSTRAINT event_classifications_methodology_fk
        FOREIGN KEY (
            classifier_version, methodology_version,
            registry_version, configuration_hash
        ) REFERENCES engagement_classifier_methodology_versions (
            classifier_version, methodology_version,
            registry_version, configuration_hash
        ),
    CONSTRAINT event_classifications_supersedes_fk
        FOREIGN KEY (tenant_id, supersedes_id)
        REFERENCES event_classifications (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT event_classifications_run_fk
        FOREIGN KEY (tenant_id, reclassification_run_id)
        REFERENCES event_reclassification_runs (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT event_classifications_subtype_shape CHECK (
        (classification = 'machine' AND machine_subtype IS NOT NULL)
        OR (classification IN ('human', 'unknown') AND machine_subtype IS NULL)
    ),
    CONSTRAINT event_classifications_supersedes_not_self CHECK (
        supersedes_id IS NULL OR supersedes_id <> id
    ),
    UNIQUE (
        tenant_id, subscriber_event_id, subscriber_event_at,
        classifier_version, methodology_version,
        registry_version, configuration_hash
    ),
    UNIQUE (tenant_id, id)
);

CREATE INDEX event_classifications_latest_idx
    ON event_classifications (
        tenant_id, subscriber_event_at, subscriber_event_id,
        classified_at DESC, id DESC
    );
CREATE INDEX event_classifications_version_idx
    ON event_classifications (
        classifier_version, methodology_version, registry_version,
        classification, classified_at DESC
    );

CREATE TABLE engagement_classifier_calibration_reports (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    classifier_version        text NOT NULL,
    methodology_version       text NOT NULL,
    registry_version          text NOT NULL,
    configuration_hash        text NOT NULL CHECK (
                                  configuration_hash ~ '^[0-9a-f]{64}$'
                              ),
    machine_corpus_manifest_hash text CHECK (
                                  machine_corpus_manifest_hash IS NULL OR
                                  machine_corpus_manifest_hash ~ '^[0-9a-f]{64}$'
                              ),
    human_corpus_manifest_hash text CHECK (
                                  human_corpus_manifest_hash IS NULL OR
                                  human_corpus_manifest_hash ~ '^[0-9a-f]{64}$'
                              ),
    machine_sample_count      bigint NOT NULL CHECK (machine_sample_count >= 0),
    human_sample_count        bigint NOT NULL CHECK (human_sample_count >= 0),
    classified_sample_count   bigint NOT NULL CHECK (classified_sample_count >= 0),
    unknown_sample_count      bigint NOT NULL CHECK (unknown_sample_count >= 0),
    machine_recall            numeric(7,6),
    machine_precision         numeric(7,6),
    false_machine_positive_rate numeric(7,6),
    human_recall              numeric(7,6),
    unknown_share             numeric(7,6) NOT NULL CHECK (
                                  unknown_share >= 0 AND unknown_share <= 1
                              ),
    confusion_matrix          jsonb NOT NULL CHECK (
                                  jsonb_typeof(confusion_matrix) = 'object'
                                  AND octet_length(confusion_matrix::text) <= 16384
                              ),
    per_source_metrics        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                                  jsonb_typeof(per_source_metrics) = 'object'
                                  AND octet_length(per_source_metrics::text) <= 65536
                              ),
    result                    text NOT NULL CHECK (
                                  result IN ('pass', 'fail', 'insufficient_corpus')
                              ),
    methodology_note          text NOT NULL CHECK (
                                  length(methodology_note) BETWEEN 1 AND 8000
                              ),
    recorded_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    report_fingerprint        text NOT NULL CHECK (
                                  report_fingerprint ~ '^[0-9a-f]{64}$'
                              ),

    CONSTRAINT engagement_classifier_calibration_methodology_fk
        FOREIGN KEY (
            classifier_version, methodology_version,
            registry_version, configuration_hash
        ) REFERENCES engagement_classifier_methodology_versions (
            classifier_version, methodology_version,
            registry_version, configuration_hash
        ),
    UNIQUE (report_fingerprint)
);

CREATE TABLE subscriber_event_observation_deletions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    observation_id           uuid NOT NULL,
    observation_fingerprint  text NOT NULL CHECK (
                                 observation_fingerprint ~ '^[0-9a-f]{64}$'
                             ),
    raw_object_ref_hash      text CHECK (
                                 raw_object_ref_hash IS NULL OR
                                 raw_object_ref_hash ~ '^[0-9a-f]{64}$'
                             ),
    reason_code              text NOT NULL CHECK (
                                 reason_code ~ '^[a-z][a-z0-9_.-]{0,95}$'
                             ),
    deleted_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, observation_id),
    UNIQUE (tenant_id, id)
);

CREATE OR REPLACE FUNCTION engagement_evidence_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    -- Branch before touching a table-specific OLD field. This function is
    -- shared by several evidence tables and PL/pgSQL does not promise record
    -- field resolution will short-circuit across an AND expression.
    IF TG_TABLE_NAME = 'subscriber_event_observations' THEN
        IF TG_OP = 'DELETE'
           AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
           AND OLD.privacy_expiry_at <= clock_timestamp() THEN
            RETURN OLD;
        END IF;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER subscriber_event_observations_append_only
    BEFORE UPDATE OR DELETE ON subscriber_event_observations
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();
CREATE TRIGGER subscriber_event_engagement_identities_append_only
    BEFORE UPDATE OR DELETE ON subscriber_event_engagement_identities
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();
CREATE TRIGGER event_classifications_append_only
    BEFORE UPDATE OR DELETE ON event_classifications
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();
CREATE TRIGGER engagement_machine_registry_entries_append_only
    BEFORE UPDATE OR DELETE ON engagement_machine_registry_entries
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();
CREATE TRIGGER engagement_classifier_methodologies_append_only
    BEFORE UPDATE OR DELETE ON engagement_classifier_methodology_versions
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();
CREATE TRIGGER engagement_classifier_calibration_reports_append_only
    BEFORE UPDATE OR DELETE ON engagement_classifier_calibration_reports
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();
CREATE TRIGGER subscriber_event_observation_deletions_append_only
    BEFORE UPDATE OR DELETE ON subscriber_event_observation_deletions
    FOR EACH ROW EXECUTE FUNCTION engagement_evidence_append_only_guard();

CREATE OR REPLACE FUNCTION event_reclassification_run_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'event reclassification runs cannot be deleted directly'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
       OR OLD.request_id IS DISTINCT FROM NEW.request_id
       OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
       OR OLD.event_window_start IS DISTINCT FROM NEW.event_window_start
       OR OLD.event_window_end IS DISTINCT FROM NEW.event_window_end
       OR OLD.classifier_version IS DISTINCT FROM NEW.classifier_version
       OR OLD.methodology_version IS DISTINCT FROM NEW.methodology_version
       OR OLD.registry_version IS DISTINCT FROM NEW.registry_version
       OR OLD.configuration_hash IS DISTINCT FROM NEW.configuration_hash
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'event reclassification run identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal event reclassification run is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'queued' AND NEW.state = 'running')
        OR (OLD.state = 'running' AND NEW.state IN ('completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid event reclassification transition: % -> %',
            OLD.state, NEW.state USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'queued' AND NEW.state = 'running'
       AND NEW.attempt_count <> 1 THEN
        RAISE EXCEPTION 'initial event reclassification lease must be attempt 1'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.candidate_count < OLD.candidate_count
       OR NEW.classified_count < OLD.classified_count
       OR NEW.unchanged_count < OLD.unchanged_count
       OR NEW.error_count < OLD.error_count THEN
        RAISE EXCEPTION 'event reclassification counters must be monotonic'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'running' AND NEW.state = 'running' THEN
        IF NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
            IF OLD.lease_expires_at > statement_timestamp()
               OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
                RAISE EXCEPTION 'active event reclassification lease cannot be stolen'
                    USING ERRCODE = '55000';
            END IF;
        ELSE
            IF NEW.attempt_count <> OLD.attempt_count THEN
                RAISE EXCEPTION 'lease attempt changes require a new token'
                    USING ERRCODE = '55000';
            END IF;
            IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                RAISE EXCEPTION 'lease owner changes require a new token'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
        IF NEW.heartbeat_at <= OLD.heartbeat_at
           OR NEW.lease_expires_at <= NEW.heartbeat_at
           OR NEW.lease_expires_at <= OLD.lease_expires_at THEN
            RAISE EXCEPTION 'event reclassification lease renewal must advance'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF OLD.state = 'running' AND NEW.state IN ('completed', 'failed')
       AND (NEW.worker_id IS DISTINCT FROM OLD.worker_id
            OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
            OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
            OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
            OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at) THEN
        RAISE EXCEPTION 'terminal event reclassification write changed lease identity'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.cursor_event_at IS NOT NULL AND NEW.cursor_event_at IS NOT NULL
       AND (NEW.cursor_event_at, NEW.cursor_event_id) <
           (OLD.cursor_event_at, OLD.cursor_event_id) THEN
        RAISE EXCEPTION 'event reclassification cursor must be monotonic'
            USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER event_reclassification_runs_guard
    BEFORE UPDATE OR DELETE ON event_reclassification_runs
    FOR EACH ROW EXECUTE FUNCTION event_reclassification_run_guard();

CREATE OR REPLACE FUNCTION purge_expired_subscriber_event_observation(
    target_tenant_id uuid,
    target_observation_id uuid,
    target_reason_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    target_fingerprint text;
    target_object_ref text;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true'
       OR current_setting('app.engagement_classifier_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'engagement observation purge requires classifier worker scope'
            USING ERRCODE = '42501';
    END IF;
    IF target_reason_code IS NULL
       OR target_reason_code !~ '^[a-z][a-z0-9_.-]{0,95}$' THEN
        RAISE EXCEPTION 'invalid engagement observation purge reason'
            USING ERRCODE = '22023';
    END IF;

    SELECT observation_fingerprint, raw_object_ref
      INTO target_fingerprint, target_object_ref
      FROM public.subscriber_event_observations
     WHERE tenant_id = target_tenant_id
       AND id = target_observation_id
       AND privacy_expiry_at <= clock_timestamp()
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- The database cannot prove deletion of an external versioned object.
    -- Refuse to erase the only exact object pointer until a composed object
    -- deleter has confirmed that exact ref/version and recorded its receipt.
    IF target_object_ref IS NOT NULL THEN
        RAISE EXCEPTION 'external engagement observation object requires exact-version deletion before database purge'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.subscriber_event_observation_deletions (
        tenant_id, observation_id, observation_fingerprint,
        raw_object_ref_hash, reason_code
    ) VALUES (
        target_tenant_id, target_observation_id, target_fingerprint,
        CASE WHEN target_object_ref IS NULL THEN NULL ELSE
            encode(digest(convert_to(target_object_ref, 'UTF8'), 'sha256'), 'hex')
        END,
        target_reason_code
    ) ON CONFLICT (tenant_id, observation_id) DO NOTHING;

    PERFORM set_config('app.engagement_observation_retention_worker', 'true', true);
    DELETE FROM public.subscriber_event_observations
     WHERE tenant_id = target_tenant_id AND id = target_observation_id;
    RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION purge_expired_subscriber_event_observation(uuid, uuid, text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_subscriber_event_observation(uuid, uuid, text)
    TO postwave_app;

-- SECURITY INVOKER preserves the underlying tenant RLS policies. Latest is a
-- presentation projection only; every historical row remains queryable in
-- event_classifications with its exact methodology provenance.
CREATE VIEW subscriber_event_classification_shadow_v1
WITH (security_invoker = true)
AS
SELECT
    event.tenant_id,
    event.id AS subscriber_event_id,
    event.at AS subscriber_event_at,
    COALESCE(classification.classification, 'unknown') AS classification,
    classification.machine_subtype,
    classification.human_confidence,
    classification.calibration_band,
    COALESCE(classification.stable_reason, 'R_NOT_YET_CLASSIFIED') AS stable_reason,
    classification.classifier_version,
    classification.methodology_version,
    classification.registry_version,
    classification.configuration_hash,
    COALESCE(classification.classification = 'human', false) AS human_signal,
    COALESCE(classification.classification = 'machine', false) AS machine_signal,
    (classification.classification IS NULL OR classification.classification = 'unknown') AS unknown_signal,
    true AS shadow_mode,
    classification.classified_at,
    classification.id AS classification_id
FROM subscriber_events AS event
LEFT JOIN LATERAL (
    SELECT current_classification.*
      FROM event_classifications AS current_classification
     WHERE current_classification.tenant_id = event.tenant_id
       AND current_classification.subscriber_event_id = event.id
       AND current_classification.subscriber_event_at = event.at
     ORDER BY current_classification.classified_at DESC,
              current_classification.id DESC
     LIMIT 1
) AS classification ON true;

COMMENT ON VIEW subscriber_event_classification_shadow_v1 IS
    'Shadow-mode F01 projection. human_signal is true only for an explicit human classification; absent and unknown evidence remain unknown.';
COMMENT ON TABLE subscriber_event_observations IS
    'Append-only raw/provenance envelopes attached to the canonical subscriber_events ledger. Direct mutation is forbidden; expired rows require the governed purge function.';
COMMENT ON TABLE event_classifications IS
    'Append-only human/machine/unknown decisions with exact rules, conflicts, configuration, and reclassification lineage.';
COMMENT ON COLUMN event_classifications.human_confidence IS
    'Product-calibrated deterministic score under the named methodology; never model self-confidence or proof a person read the message.';

GRANT SELECT, INSERT ON subscriber_event_observations TO postwave_app;
GRANT SELECT ON subscriber_event_engagement_identities TO postwave_app;
GRANT SELECT, INSERT ON event_classifications TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON event_reclassification_runs TO postwave_app;
GRANT SELECT, INSERT ON engagement_machine_registry_entries TO postwave_app;
GRANT SELECT, INSERT ON engagement_classifier_methodology_versions TO postwave_app;
GRANT SELECT, INSERT ON engagement_classifier_calibration_reports TO postwave_app;
GRANT SELECT, INSERT ON subscriber_event_observation_deletions TO postwave_app;
GRANT SELECT ON subscriber_event_classification_shadow_v1 TO postwave_app;

REVOKE UPDATE, DELETE, TRUNCATE ON subscriber_event_observations FROM postwave_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON subscriber_event_engagement_identities FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON event_classifications FROM postwave_app;
REVOKE DELETE, TRUNCATE ON event_reclassification_runs FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON engagement_machine_registry_entries FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON engagement_classifier_methodology_versions FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON engagement_classifier_calibration_reports FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON subscriber_event_observation_deletions FROM postwave_app;

ALTER TABLE subscriber_event_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_event_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_event_engagement_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_event_engagement_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE event_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_classifications FORCE ROW LEVEL SECURITY;
ALTER TABLE event_reclassification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_reclassification_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_machine_registry_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_machine_registry_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_classifier_methodology_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_classifier_methodology_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement_classifier_calibration_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_classifier_calibration_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_event_observation_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_event_observation_deletions FORCE ROW LEVEL SECURITY;

CREATE POLICY subscriber_event_observations_worker_select
    ON subscriber_event_observations FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY subscriber_event_engagement_identities_worker_select
    ON subscriber_event_engagement_identities FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY subscriber_event_observations_worker_insert
    ON subscriber_event_observations FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

CREATE POLICY event_classifications_tenant_select
    ON event_classifications FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY event_classifications_worker_insert
    ON event_classifications FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

CREATE POLICY event_reclassification_runs_tenant_select
    ON event_reclassification_runs FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY event_reclassification_runs_worker_insert
    ON event_reclassification_runs FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY event_reclassification_runs_worker_update
    ON event_reclassification_runs FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

CREATE POLICY engagement_machine_registry_worker_select
    ON engagement_machine_registry_entries FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY engagement_machine_registry_worker_insert
    ON engagement_machine_registry_entries FOR INSERT TO postwave_app
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_registry_writer', true) = 'true'
    );

CREATE POLICY engagement_classifier_methodology_select
    ON engagement_classifier_methodology_versions FOR SELECT TO postwave_app
    USING (true);
CREATE POLICY engagement_classifier_methodology_worker_insert
    ON engagement_classifier_methodology_versions FOR INSERT TO postwave_app
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

CREATE POLICY engagement_classifier_calibration_worker_select
    ON engagement_classifier_calibration_reports FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY engagement_classifier_calibration_worker_insert
    ON engagement_classifier_calibration_reports FOR INSERT TO postwave_app
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

CREATE POLICY subscriber_event_observation_deletions_worker_select
    ON subscriber_event_observation_deletions FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY subscriber_event_observation_deletions_worker_insert
    ON subscriber_event_observation_deletions FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );

COMMIT;
