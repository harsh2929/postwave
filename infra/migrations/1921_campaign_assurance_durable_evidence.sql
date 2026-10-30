-- 1921_campaign_assurance_durable_evidence.sql
--
-- Durable Campaign Assurance evidence. A run snapshots the exact immutable
-- revision, send plan, render artifacts, and analyzer configurations before a
-- worker can claim it. Worker attempts are leased and fenced; every extraction
-- and finding is attempt-scoped and first-write-wins. Overrides are separate
-- append-only governance receipts and never rewrite the underlying evidence.
--
-- Raw model output remains behind an encrypted, expiring object reference.
-- The durable database receipt contains hashes, normalized structured output,
-- bounded public errors, methodology versions, and no real subscriber PII.
--
-- rollback-strategy: no-op. These additive evidence records may already be
-- referenced by audit/send receipts and must not be destroyed by rollback.

BEGIN;

-- These identities let assurance rows prove that their copied hashes belong
-- to the exact parent revision/plan/artifact, not merely to the same tenant.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_content_revisions_assurance_identity_uidx
    ON campaign_content_revisions (
        tenant_id, campaign_id, id, source_hash
    );

CREATE UNIQUE INDEX IF NOT EXISTS campaign_send_plans_assurance_identity_uidx
    ON campaign_send_plans (
        tenant_id, campaign_id, content_revision_id, id, plan_hash
    );

CREATE UNIQUE INDEX IF NOT EXISTS campaign_render_artifacts_assurance_identity_uidx
    ON campaign_render_artifacts (
        tenant_id, campaign_id, send_plan_id, id, scenario_id,
        outbound_mime_hash, mime_structure_hash
    );

CREATE TABLE campaign_assurance_runs (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id                     uuid NOT NULL,
    content_revision_id             uuid NOT NULL,
    send_plan_id                    uuid NOT NULL,
    run_no                          bigint NOT NULL CHECK (run_no > 0),
    request_id                      uuid NOT NULL,
    request_hash                    text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    trigger_kind                    text NOT NULL CHECK (trigger_kind IN (
                                        'draft', 'explicit', 'queue', 'seed',
                                        'scheduled_recheck'
                                    )),
    profile                         text NOT NULL CHECK (profile IN (
                                        'fast', 'full', 'calibration'
                                    )),
    state                           text NOT NULL DEFAULT 'queued' CHECK (state IN (
                                        'queued', 'running', 'complete', 'incomplete',
                                        'failed', 'cancelled', 'stale'
                                    )),

    -- Exact source/compiler/artifact identity.
    source_hash                     text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    plan_hash                       text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
    artifact_set_hash               text CHECK (
                                        artifact_set_hash IS NULL OR artifact_set_hash ~ '^[0-9a-f]{64}$'
                                    ),
    coverage_manifest_hash          text NOT NULL CHECK (coverage_manifest_hash ~ '^[0-9a-f]{64}$'),
    configuration_manifest_hash     text CHECK (
                                        configuration_manifest_hash IS NULL OR
                                        configuration_manifest_hash ~ '^[0-9a-f]{64}$'
                                    ),
    target_manifest_hash            text CHECK (
                                        target_manifest_hash IS NULL OR target_manifest_hash ~ '^[0-9a-f]{64}$'
                                    ),
    renderer_version                text NOT NULL CHECK (length(renderer_version) BETWEEN 1 AND 160),
    compiler_version                text NOT NULL CHECK (length(compiler_version) BETWEEN 1 AND 160),
    fixture_set_version             text NOT NULL CHECK (length(fixture_set_version) BETWEEN 1 AND 160),
    plan_policy_version             text NOT NULL CHECK (length(plan_policy_version) BETWEEN 1 AND 160),

    -- Analyzer/methodology provenance. A hosted model snapshot may still
    -- drift; these fields state exactly what the service requested.
    analyzer_suite_version          text NOT NULL CHECK (length(analyzer_suite_version) BETWEEN 1 AND 160),
    model_suite_version             text NOT NULL CHECK (length(model_suite_version) BETWEEN 1 AND 200),
    prompt_suite_version            text NOT NULL CHECK (length(prompt_suite_version) BETWEEN 1 AND 160),
    prompt_suite_hash               text NOT NULL CHECK (prompt_suite_hash ~ '^[0-9a-f]{64}$'),
    normalization_version           text NOT NULL CHECK (length(normalization_version) BETWEEN 1 AND 160),
    scoring_version                 text NOT NULL CHECK (length(scoring_version) BETWEEN 1 AND 160),
    gate_policy_version             text NOT NULL CHECK (length(gate_policy_version) BETWEEN 1 AND 160),
    methodology_version             text NOT NULL CHECK (length(methodology_version) BETWEEN 1 AND 160),

    required_scenario_count         integer NOT NULL CHECK (required_scenario_count BETWEEN 1 AND 10000),
    required_configuration_count    integer NOT NULL CHECK (required_configuration_count BETWEEN 1 AND 64),
    required_extraction_count       integer NOT NULL CHECK (
                                        required_extraction_count BETWEEN 1 AND 100000
                                    ),
    terminal_extraction_count       integer NOT NULL DEFAULT 0 CHECK (
                                        terminal_extraction_count BETWEEN 0 AND required_extraction_count
                                    ),
    successful_extraction_count     integer NOT NULL DEFAULT 0 CHECK (
                                        successful_extraction_count BETWEEN 0 AND terminal_extraction_count
                                    ),
    extraction_error_count          integer NOT NULL DEFAULT 0 CHECK (
                                        extraction_error_count BETWEEN 0 AND terminal_extraction_count
                                        AND successful_extraction_count + extraction_error_count =
                                            terminal_extraction_count
                                    ),
    finding_count                   integer NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
    blocking_finding_count          integer NOT NULL DEFAULT 0 CHECK (
                                        blocking_finding_count BETWEEN 0 AND finding_count
                                    ),

    component_scores                jsonb CHECK (
                                        component_scores IS NULL OR (
                                            jsonb_typeof(component_scores) = 'object'
                                            AND octet_length(component_scores::text) <= 65536
                                        )
                                    ),
    overall_score                   numeric(7,4) CHECK (
                                        overall_score IS NULL OR overall_score BETWEEN 0 AND 100
                                    ),
    score_min                       numeric(7,4) CHECK (
                                        score_min IS NULL OR score_min BETWEEN 0 AND 100
                                    ),
    score_max                       numeric(7,4) CHECK (
                                        score_max IS NULL OR score_max BETWEEN 0 AND 100
                                    ),
    score_spread                    numeric(7,4) CHECK (
                                        score_spread IS NULL OR score_spread BETWEEN 0 AND 100
                                    ),
    agreement                       numeric(7,6) CHECK (
                                        agreement IS NULL OR agreement BETWEEN 0 AND 1
                                    ),
    gate_decision                   text NOT NULL DEFAULT 'pending' CHECK (gate_decision IN (
                                        'pending', 'pass', 'warn', 'block', 'unavailable'
                                    )),
    input_tokens                    bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens                   bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost_microunits                 bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
    latency_ms                      bigint NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),

    snapshot_frozen_at              timestamptz,
    claim_token                     uuid,
    lease_owner                     text,
    lease_expires_at                timestamptz,
    heartbeat_at                    timestamptz,
    attempt_count                   integer NOT NULL DEFAULT 0,
    max_attempts                    integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
    retry_not_before                timestamptz,
    error_code                      text CHECK (
                                        error_code IS NULL OR
                                        error_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
                                    ),
    error_message                   text CHECK (
                                        error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000
                                    ),
    created_by                      uuid,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    started_at                      timestamptz,
    completed_at                    timestamptz,
    cancelled_at                    timestamptz,
    stale_at                        timestamptz,
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_assurance_runs_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_runs_revision_identity_fk
        FOREIGN KEY (tenant_id, campaign_id, content_revision_id, source_hash)
        REFERENCES campaign_content_revisions (
            tenant_id, campaign_id, id, source_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_runs_plan_identity_fk
        FOREIGN KEY (
            tenant_id, campaign_id, content_revision_id, send_plan_id, plan_hash
        )
        REFERENCES campaign_send_plans (
            tenant_id, campaign_id, content_revision_id, id, plan_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_runs_score_shape_check CHECK (
        (score_min IS NULL AND score_max IS NULL AND score_spread IS NULL)
        OR
        (score_min IS NOT NULL AND score_max IS NOT NULL AND score_spread IS NOT NULL
            AND score_min <= score_max
            AND abs(score_spread - (score_max - score_min)) <= 0.0001
            AND (overall_score IS NULL OR overall_score BETWEEN score_min AND score_max))
    ),
    CONSTRAINT campaign_assurance_runs_attempt_bounds_check CHECK (
        attempt_count BETWEEN 0 AND max_attempts
    ),
    CONSTRAINT campaign_assurance_runs_error_pair_check CHECK (
        (error_code IS NULL) = (error_message IS NULL)
    ),
    CONSTRAINT campaign_assurance_runs_active_receipt_shape_check CHECK (
        state NOT IN ('queued', 'running') OR (
            terminal_extraction_count = 0
            AND successful_extraction_count = 0
            AND extraction_error_count = 0
            AND finding_count = 0
            AND blocking_finding_count = 0
            AND component_scores IS NULL
            AND overall_score IS NULL
            AND score_min IS NULL AND score_max IS NULL AND score_spread IS NULL
            AND agreement IS NULL
            AND input_tokens = 0 AND output_tokens = 0
            AND cost_microunits = 0 AND latency_ms = 0
        )
    ),
    CONSTRAINT campaign_assurance_runs_timestamp_order_check CHECK (
        (snapshot_frozen_at IS NULL OR snapshot_frozen_at >= created_at)
        AND (started_at IS NULL OR started_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (cancelled_at IS NULL OR cancelled_at >= created_at)
        AND (stale_at IS NULL OR stale_at >= created_at)
        AND (heartbeat_at IS NULL OR heartbeat_at >= created_at)
        AND (lease_expires_at IS NULL OR (
            heartbeat_at IS NOT NULL AND lease_expires_at > heartbeat_at
        ))
    ),
    CONSTRAINT campaign_assurance_runs_state_shape_check CHECK (
        (state = 'queued'
            AND claim_token IS NULL AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND completed_at IS NULL AND cancelled_at IS NULL AND stale_at IS NULL
            AND gate_decision = 'pending'
            AND (
                (snapshot_frozen_at IS NULL
                    AND artifact_set_hash IS NULL
                    AND configuration_manifest_hash IS NULL
                    AND target_manifest_hash IS NULL)
                OR
                (snapshot_frozen_at IS NOT NULL
                    AND artifact_set_hash IS NOT NULL
                    AND configuration_manifest_hash IS NOT NULL
                    AND target_manifest_hash IS NOT NULL)
            ))
        OR
        (state = 'running'
            AND snapshot_frozen_at IS NOT NULL
            AND artifact_set_hash IS NOT NULL
            AND configuration_manifest_hash IS NOT NULL
            AND target_manifest_hash IS NOT NULL
            AND claim_token IS NOT NULL
            AND lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 200
            AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
            AND retry_not_before IS NULL AND attempt_count >= 1
            AND started_at IS NOT NULL AND completed_at IS NULL
            AND cancelled_at IS NULL AND stale_at IS NULL
            AND gate_decision = 'pending')
        OR
        (state = 'complete'
            AND snapshot_frozen_at IS NOT NULL
            AND artifact_set_hash IS NOT NULL
            AND configuration_manifest_hash IS NOT NULL
            AND target_manifest_hash IS NOT NULL
            AND claim_token IS NULL AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND retry_not_before IS NULL AND completed_at IS NOT NULL
            AND cancelled_at IS NULL AND stale_at IS NULL
            AND terminal_extraction_count = required_extraction_count
            AND successful_extraction_count = required_extraction_count
            AND extraction_error_count = 0
            AND gate_decision IN ('pass', 'warn', 'block'))
        OR
        (state = 'incomplete'
            AND snapshot_frozen_at IS NOT NULL
            AND artifact_set_hash IS NOT NULL
            AND configuration_manifest_hash IS NOT NULL
            AND target_manifest_hash IS NOT NULL
            AND claim_token IS NULL AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND retry_not_before IS NULL AND completed_at IS NOT NULL
            AND cancelled_at IS NULL AND stale_at IS NULL
            AND (terminal_extraction_count < required_extraction_count
                 OR extraction_error_count > 0)
            AND component_scores IS NULL AND overall_score IS NULL
            AND score_min IS NULL AND score_max IS NULL AND score_spread IS NULL
            AND agreement IS NULL
            AND gate_decision = 'unavailable')
        OR
        (state = 'failed'
            AND snapshot_frozen_at IS NOT NULL
            AND artifact_set_hash IS NOT NULL
            AND configuration_manifest_hash IS NOT NULL
            AND target_manifest_hash IS NOT NULL
            AND claim_token IS NULL AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND retry_not_before IS NULL AND completed_at IS NOT NULL
            AND cancelled_at IS NULL AND stale_at IS NULL
            AND error_code IS NOT NULL AND error_message IS NOT NULL
            AND component_scores IS NULL AND overall_score IS NULL
            AND score_min IS NULL AND score_max IS NULL AND score_spread IS NULL
            AND agreement IS NULL
            AND gate_decision = 'unavailable')
        OR
        (state = 'cancelled'
            AND claim_token IS NULL AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND retry_not_before IS NULL AND completed_at IS NOT NULL
            AND cancelled_at IS NOT NULL AND stale_at IS NULL
            AND gate_decision = 'unavailable')
        OR
        (state = 'stale'
            AND claim_token IS NULL AND lease_owner IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND retry_not_before IS NULL AND completed_at IS NOT NULL
            AND stale_at IS NOT NULL AND cancelled_at IS NULL)
    ),
    UNIQUE (tenant_id, campaign_id, run_no),
    UNIQUE (tenant_id, campaign_id, request_id),
    UNIQUE (tenant_id, campaign_id, id),
    UNIQUE (tenant_id, campaign_id, id, send_plan_id),
    UNIQUE (
        tenant_id, campaign_id, id, attempt_count, artifact_set_hash
    ),
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX campaign_assurance_runs_one_active_artifact_profile_uidx
    ON campaign_assurance_runs (
        tenant_id, campaign_id, send_plan_id, artifact_set_hash, profile
    )
    WHERE state IN ('queued', 'running');

CREATE INDEX campaign_assurance_runs_campaign_created_idx
    ON campaign_assurance_runs (tenant_id, campaign_id, created_at DESC, id DESC);

CREATE INDEX campaign_assurance_runs_worker_claim_idx
    ON campaign_assurance_runs (retry_not_before, created_at, id)
    WHERE state = 'queued';

CREATE INDEX campaign_assurance_runs_stale_lease_idx
    ON campaign_assurance_runs (lease_expires_at, heartbeat_at, id)
    WHERE state = 'running';

-- Exact required scenario manifest for the run. Hashes are repeated on purpose:
-- the composite FK proves they still identify the immutable artifact.
CREATE TABLE campaign_assurance_run_artifacts (
    tenant_id                  uuid NOT NULL,
    campaign_id                uuid NOT NULL,
    run_id                     uuid NOT NULL,
    send_plan_id               uuid NOT NULL,
    artifact_id                uuid NOT NULL,
    ordinal                    integer NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
    scenario_id                text NOT NULL CHECK (length(scenario_id) BETWEEN 1 AND 200),
    outbound_mime_hash         text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    mime_structure_hash        text NOT NULL CHECK (mime_structure_hash ~ '^[0-9a-f]{64}$'),
    snapshotted_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, artifact_id),
    UNIQUE (tenant_id, run_id, ordinal),
    UNIQUE (tenant_id, run_id, scenario_id),
    UNIQUE (tenant_id, campaign_id, run_id, send_plan_id, artifact_id),
    UNIQUE (
        tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
        outbound_mime_hash
    ),
    CONSTRAINT campaign_assurance_run_artifacts_run_fk
        FOREIGN KEY (tenant_id, campaign_id, run_id, send_plan_id)
        REFERENCES campaign_assurance_runs (
            tenant_id, campaign_id, id, send_plan_id
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_run_artifacts_artifact_identity_fk
        FOREIGN KEY (
            tenant_id, campaign_id, send_plan_id, artifact_id, scenario_id,
            outbound_mime_hash, mime_structure_hash
        )
        REFERENCES campaign_render_artifacts (
            tenant_id, campaign_id, send_plan_id, id, scenario_id,
            outbound_mime_hash, mime_structure_hash
        )
        ON DELETE CASCADE
);

-- Closed analyzer/configuration manifest. An extraction cannot invent a new
-- configuration after the run has been claimed.
CREATE TABLE campaign_assurance_run_configurations (
    tenant_id                  uuid NOT NULL,
    campaign_id                uuid NOT NULL,
    run_id                     uuid NOT NULL,
    ordinal                    integer NOT NULL CHECK (ordinal BETWEEN 1 AND 64),
    configuration_id           text NOT NULL CHECK (
                                     configuration_id ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                                 ),
    source_class               text NOT NULL CHECK (source_class IN (
                                     'deterministic', 'modeled', 'controlled_observation'
                                 )),
    configuration_hash         text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
    configuration              jsonb NOT NULL CHECK (
                                   jsonb_typeof(configuration) = 'object'
                                   AND octet_length(configuration::text) <= 65536
                               ),
    snapshotted_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, configuration_id),
    UNIQUE (tenant_id, run_id, ordinal),
    UNIQUE (
        tenant_id, campaign_id, run_id, configuration_id, configuration_hash
    ),
    UNIQUE (
        tenant_id, campaign_id, run_id, configuration_id,
        source_class, configuration_hash
    ),
    CONSTRAINT campaign_assurance_run_configurations_run_fk
        FOREIGN KEY (tenant_id, campaign_id, run_id)
        REFERENCES campaign_assurance_runs (tenant_id, campaign_id, id)
        ON DELETE CASCADE
);

-- Explicit required target cells support sparse suites: for example, a
-- controlled client observation may apply to one scenario while deterministic
-- checks and modeled configurations apply to every scenario. Completion is
-- measured against this table, never an assumed Cartesian product.
CREATE TABLE campaign_assurance_run_targets (
    tenant_id                  uuid NOT NULL,
    campaign_id                uuid NOT NULL,
    run_id                     uuid NOT NULL,
    send_plan_id               uuid NOT NULL,
    artifact_id                uuid NOT NULL,
    configuration_id           text NOT NULL,
    ordinal                    integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100000),
    source_class               text NOT NULL CHECK (source_class IN (
                                     'deterministic', 'modeled', 'controlled_observation'
                                 )),
    configuration_hash         text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
    outbound_mime_hash         text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    snapshotted_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, artifact_id, configuration_id),
    UNIQUE (tenant_id, run_id, ordinal),
    UNIQUE (
        tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
        configuration_id, source_class, configuration_hash, outbound_mime_hash
    ),
    CONSTRAINT campaign_assurance_run_targets_artifact_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            outbound_mime_hash
        )
        REFERENCES campaign_assurance_run_artifacts (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            outbound_mime_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_run_targets_configuration_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, configuration_id,
            source_class, configuration_hash
        )
        REFERENCES campaign_assurance_run_configurations (
            tenant_id, campaign_id, run_id, configuration_id,
            source_class, configuration_hash
        )
        ON DELETE CASCADE
);

CREATE TABLE campaign_assurance_extractions (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL,
    campaign_id                 uuid NOT NULL,
    run_id                      uuid NOT NULL,
    send_plan_id                uuid NOT NULL,
    artifact_id                 uuid NOT NULL,
    configuration_id            text NOT NULL,
    source_class                text NOT NULL CHECK (source_class IN (
                                      'deterministic', 'modeled', 'controlled_observation'
                                  )),
    configuration_hash          text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
    outbound_mime_hash           text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    attempt_count                integer NOT NULL CHECK (attempt_count >= 1),
    claim_token                  uuid NOT NULL,
    status                       text NOT NULL CHECK (status IN (
                                     'complete', 'error', 'unavailable'
                                 )),
    normalized_extraction        jsonb,
    evidence_manifest            jsonb NOT NULL DEFAULT '{}'::jsonb
                                 CHECK (
                                     jsonb_typeof(evidence_manifest) = 'object'
                                     AND octet_length(evidence_manifest::text) <= 65536
                                 ),
    unsupported_claims           jsonb NOT NULL DEFAULT '[]'::jsonb
                                 CHECK (
                                     jsonb_typeof(unsupported_claims) = 'array'
                                     AND octet_length(unsupported_claims::text) <= 65536
                                 ),
    ambiguities                  jsonb NOT NULL DEFAULT '[]'::jsonb
                                 CHECK (
                                     jsonb_typeof(ambiguities) = 'array'
                                     AND octet_length(ambiguities::text) <= 65536
                                 ),
    raw_output_object_ref        text,
    raw_output_hash              text CHECK (
                                     raw_output_hash IS NULL OR raw_output_hash ~ '^[0-9a-f]{64}$'
                                 ),
    raw_output_expires_at        timestamptz,
    model_provider               text CHECK (
                                      model_provider IS NULL OR length(model_provider) BETWEEN 1 AND 100
                                  ),
    model_id                     text CHECK (
                                      model_id IS NULL OR length(model_id) BETWEEN 1 AND 200
                                  ),
    model_version                text CHECK (
                                      model_version IS NULL OR length(model_version) BETWEEN 1 AND 200
                                  ),
    prompt_version               text CHECK (
                                      prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 160
                                  ),
    prompt_hash                  text CHECK (
                                      prompt_hash IS NULL OR prompt_hash ~ '^[0-9a-f]{64}$'
                                  ),
    seed_value                   text CHECK (seed_value IS NULL OR length(seed_value) <= 160),
    temperature                  numeric(6,4) CHECK (
                                     temperature IS NULL OR temperature BETWEEN 0 AND 2
                                 ),
    input_tokens                 bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens                bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost_microunits              bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
    latency_ms                   bigint NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    error_code                   text CHECK (
                                     error_code IS NULL OR
                                     error_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
                                 ),
    error_message                text CHECK (
                                     error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000
                                 ),
    receipt_hash                 text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    created_at                   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_assurance_extractions_target_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            configuration_id, source_class, configuration_hash, outbound_mime_hash
        )
        REFERENCES campaign_assurance_run_targets (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            configuration_id, source_class, configuration_hash, outbound_mime_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_extractions_receipt_shape_check CHECK (
        (status = 'complete'
            AND jsonb_typeof(normalized_extraction) = 'object'
            AND octet_length(normalized_extraction::text) <= 131072
            AND error_code IS NULL AND error_message IS NULL)
        OR
        (status IN ('error', 'unavailable')
            AND normalized_extraction IS NULL
            AND error_code IS NOT NULL AND error_message IS NOT NULL)
    ),
    CONSTRAINT campaign_assurance_extractions_raw_object_shape_check CHECK (
        (raw_output_object_ref IS NULL
            AND raw_output_hash IS NULL AND raw_output_expires_at IS NULL)
        OR
        (raw_output_object_ref IS NOT NULL
            AND length(raw_output_object_ref) BETWEEN 1 AND 2000
            -- Opaque, tenant-relative internal references only. Tenant
            -- ownership comes from this row and the bound object-store
            -- namespace; a caller cannot smuggle a URL, absolute path, or
            -- traversal segment into the durable receipt.
            AND raw_output_object_ref ~
                '^postwave\.tenant-object-ref\.v1:campaign-assurance/raw-output/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,29}$'
            AND raw_output_hash IS NOT NULL
            AND raw_output_expires_at IS NOT NULL
            AND raw_output_expires_at > created_at
            AND raw_output_expires_at <= created_at + interval '30 days')
    ),
    CONSTRAINT campaign_assurance_extractions_model_identity_check CHECK (
        (source_class = 'modeled'
            AND model_provider IS NOT NULL AND model_id IS NOT NULL
            AND model_version IS NOT NULL AND prompt_version IS NOT NULL
            AND prompt_hash IS NOT NULL)
        OR
        (source_class IN ('deterministic', 'controlled_observation'))
    ),
    UNIQUE (
        tenant_id, run_id, attempt_count, artifact_id, configuration_id
    ),
    UNIQUE (
        tenant_id, campaign_id, run_id, attempt_count, claim_token,
        artifact_id, configuration_id, id
    )
);

CREATE INDEX campaign_assurance_extractions_run_attempt_idx
    ON campaign_assurance_extractions (
        tenant_id, run_id, attempt_count, artifact_id, configuration_id
    );

CREATE INDEX campaign_assurance_extractions_raw_expiry_idx
    ON campaign_assurance_extractions (raw_output_expires_at, id)
    WHERE raw_output_expires_at IS NOT NULL;

CREATE TABLE campaign_assurance_findings (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL,
    campaign_id                 uuid NOT NULL,
    run_id                      uuid NOT NULL,
    send_plan_id                uuid NOT NULL,
    artifact_id                 uuid NOT NULL,
    configuration_id            text NOT NULL,
    source_class                text NOT NULL CHECK (source_class IN (
                                      'deterministic', 'modeled', 'controlled_observation'
                                  )),
    configuration_hash          text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
    outbound_mime_hash           text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    attempt_count               integer NOT NULL CHECK (attempt_count >= 1),
    claim_token                 uuid NOT NULL,
    extraction_id               uuid,
    finding_key                 text NOT NULL CHECK (finding_key ~ '^[0-9a-f]{64}$'),
    receipt_hash                text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    code                        text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
    severity                    text NOT NULL CHECK (severity IN (
                                     'info', 'warning', 'error', 'critical'
                                 )),
    blocking                    boolean NOT NULL DEFAULT false,
    overridable                 boolean NOT NULL DEFAULT false,
    dimension                   text NOT NULL CHECK (
                                     dimension ~ '^[a-z][a-z0-9_.-]{0,95}$'
                                 ),
    block_references            jsonb NOT NULL DEFAULT '[]'::jsonb
                                 CHECK (
                                     jsonb_typeof(block_references) = 'array'
                                     AND octet_length(block_references::text) <= 32768
                                 ),
    evidence_references         jsonb NOT NULL DEFAULT '[]'::jsonb
                                 CHECK (
                                     jsonb_typeof(evidence_references) = 'array'
                                     AND octet_length(evidence_references::text) <= 32768
                                 ),
    expected_value              jsonb,
    observed_value              jsonb,
    explanation                 text NOT NULL CHECK (length(explanation) BETWEEN 1 AND 4000),
    remediation                 jsonb NOT NULL DEFAULT '{}'::jsonb
                                 CHECK (
                                     jsonb_typeof(remediation) = 'object'
                                     AND octet_length(remediation::text) <= 32768
                                 ),
    typed_patch                 jsonb CHECK (
                                     typed_patch IS NULL OR jsonb_typeof(typed_patch) = 'object'
                                 ),
    typed_patch_schema_version  integer CHECK (
                                     typed_patch_schema_version IS NULL OR
                                     typed_patch_schema_version BETWEEN 1 AND 1000
                                 ),
    typed_patch_hash            text CHECK (
                                     typed_patch_hash IS NULL OR typed_patch_hash ~ '^[0-9a-f]{64}$'
                                 ),
    detector_version            text NOT NULL CHECK (length(detector_version) BETWEEN 1 AND 160),
    policy_version              text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 160),
    created_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_assurance_findings_target_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            configuration_id, source_class, configuration_hash, outbound_mime_hash
        )
        REFERENCES campaign_assurance_run_targets (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            configuration_id, source_class, configuration_hash, outbound_mime_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_findings_extraction_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, attempt_count, claim_token,
            artifact_id, configuration_id, extraction_id
        )
        REFERENCES campaign_assurance_extractions (
            tenant_id, campaign_id, run_id, attempt_count, claim_token,
            artifact_id, configuration_id, id
        ),
    CONSTRAINT campaign_assurance_findings_patch_shape_check CHECK (
        (typed_patch IS NULL
            AND typed_patch_schema_version IS NULL AND typed_patch_hash IS NULL)
        OR
        (jsonb_typeof(typed_patch) = 'object'
            AND octet_length(typed_patch::text) <= 32768
            AND typed_patch_schema_version IS NOT NULL
            AND typed_patch_hash IS NOT NULL)
    ),
    CONSTRAINT campaign_assurance_findings_value_size_check CHECK (
        (expected_value IS NULL OR octet_length(expected_value::text) <= 32768)
        AND (observed_value IS NULL OR octet_length(observed_value::text) <= 32768)
    ),
    UNIQUE (tenant_id, run_id, attempt_count, finding_key),
    UNIQUE (tenant_id, campaign_id, run_id, attempt_count, id),
    UNIQUE (
        tenant_id, campaign_id, run_id, attempt_count, id, receipt_hash
    )
);

CREATE INDEX campaign_assurance_findings_run_attempt_idx
    ON campaign_assurance_findings (
        tenant_id, run_id, attempt_count, blocking DESC, severity, code
    );

CREATE TABLE campaign_assurance_overrides (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL,
    campaign_id                 uuid NOT NULL,
    run_id                      uuid NOT NULL,
    attempt_count               integer NOT NULL CHECK (attempt_count >= 1),
    finding_id                  uuid NOT NULL,
    finding_receipt_hash        text NOT NULL CHECK (finding_receipt_hash ~ '^[0-9a-f]{64}$'),
    request_id                  uuid NOT NULL,
    request_hash                text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    artifact_set_hash           text NOT NULL CHECK (artifact_set_hash ~ '^[0-9a-f]{64}$'),
    actor_id                    uuid NOT NULL,
    actor_role                  text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
    decision                    text NOT NULL CHECK (decision IN (
                                     'allow_send', 'reject'
                                 )),
    reason                      text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
    expires_at                  timestamptz,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_assurance_overrides_run_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, attempt_count, artifact_set_hash
        )
        REFERENCES campaign_assurance_runs (
            tenant_id, campaign_id, id, attempt_count, artifact_set_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_overrides_finding_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, attempt_count, finding_id,
            finding_receipt_hash
        )
        REFERENCES campaign_assurance_findings (
            tenant_id, campaign_id, run_id, attempt_count, id, receipt_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_overrides_expiry_check
        CHECK (expires_at IS NULL OR expires_at > created_at),
    UNIQUE (tenant_id, run_id, request_id, finding_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX campaign_assurance_overrides_run_created_idx
    ON campaign_assurance_overrides (tenant_id, run_id, created_at, id);

-- A plan's artifact set must stop changing once compilation leaves preparing;
-- otherwise an exact assurance snapshot can silently omit a late artifact.
CREATE OR REPLACE FUNCTION campaign_render_artifacts_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    parent_state text;
BEGIN
    SELECT state
      INTO parent_state
      FROM public.campaign_send_plans
     WHERE tenant_id = NEW.tenant_id
       AND campaign_id = NEW.campaign_id
       AND id = NEW.send_plan_id
     FOR SHARE;
    IF NOT FOUND OR parent_state <> 'preparing' THEN
        RAISE EXCEPTION 'campaign render artifacts may only be added to a preparing plan'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_render_artifacts_insert_frozen_plan_guard
    BEFORE INSERT ON campaign_render_artifacts
    FOR EACH ROW EXECUTE FUNCTION campaign_render_artifacts_insert_guard();

-- Run lifecycle mutation is narrow and auditable. JSONB subtraction provides
-- an exact allowlist of fields for each transition so a lease heartbeat cannot
-- also rewrite provenance or a score receipt.
CREATE OR REPLACE FUNCTION campaign_assurance_runs_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    allowed_fields text[];
    artifact_count integer;
    artifact_min integer;
    artifact_max integer;
    configuration_count integer;
    configuration_min integer;
    configuration_max integer;
    target_count integer;
    target_min integer;
    target_max integer;
    frozen_artifact_hash text;
    frozen_configuration_hash text;
    frozen_target_hash text;
    parent_plan_state text;
    actual_terminal integer;
    actual_successful integer;
    actual_errors integer;
    actual_findings integer;
    actual_blocking integer;
    actual_input_tokens bigint;
    actual_output_tokens bigint;
    actual_cost_microunits bigint;
    actual_latency_ms bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'queued' OR NEW.snapshot_frozen_at IS NOT NULL OR
           NEW.artifact_set_hash IS NOT NULL OR
           NEW.configuration_manifest_hash IS NOT NULL OR
           NEW.target_manifest_hash IS NOT NULL OR
           NEW.attempt_count <> 0 OR NEW.retry_not_before IS NOT NULL OR
           NEW.error_code IS NOT NULL OR NEW.error_message IS NOT NULL OR
           NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR
           NEW.cancelled_at IS NOT NULL OR NEW.stale_at IS NOT NULL THEN
            RAISE EXCEPTION 'new campaign assurance run must begin as an unfrozen queued input'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.campaigns
             WHERE tenant_id = OLD.tenant_id AND id = OLD.campaign_id
        ) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'campaign assurance runs are durable evidence'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.state IN ('failed', 'cancelled', 'stale') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal campaign assurance run is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.state = OLD.state THEN
        IF OLD.state = 'queued' AND OLD.snapshot_frozen_at IS NULL THEN
            allowed_fields := ARRAY[
                'artifact_set_hash', 'configuration_manifest_hash',
                'target_manifest_hash', 'snapshot_frozen_at', 'updated_at'
            ];
            IF NEW.snapshot_frozen_at IS NULL THEN
                RAISE EXCEPTION 'campaign assurance snapshot must freeze exactly once'
                    USING ERRCODE = '55000';
            END IF;

            SELECT state
              INTO parent_plan_state
              FROM public.campaign_send_plans
             WHERE tenant_id = OLD.tenant_id
               AND campaign_id = OLD.campaign_id
               AND id = OLD.send_plan_id
               AND content_revision_id = OLD.content_revision_id
               AND plan_hash = OLD.plan_hash
             FOR SHARE;
            IF NOT FOUND OR parent_plan_state NOT IN ('ready', 'certified') THEN
                RAISE EXCEPTION 'campaign assurance snapshot requires a ready immutable plan'
                    USING ERRCODE = '55000';
            END IF;

            SELECT count(*)::integer,
                   COALESCE(min(ordinal), 0)::integer,
                   COALESCE(max(ordinal), 0)::integer,
                   pg_catalog.encode(public.digest(pg_catalog.convert_to(
                       COALESCE(jsonb_agg(jsonb_build_object(
                           'ordinal', ordinal,
                           'artifact_id', artifact_id::text,
                           'scenario_id', scenario_id,
                           'outbound_mime_hash', outbound_mime_hash,
                           'mime_structure_hash', mime_structure_hash
                       ) ORDER BY ordinal)::text, '[]'), 'UTF8'), 'sha256'), 'hex')
              INTO artifact_count, artifact_min, artifact_max, frozen_artifact_hash
              FROM public.campaign_assurance_run_artifacts
             WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id;

            SELECT count(*)::integer,
                   COALESCE(min(ordinal), 0)::integer,
                   COALESCE(max(ordinal), 0)::integer,
                   pg_catalog.encode(public.digest(pg_catalog.convert_to(
                       COALESCE(jsonb_agg(jsonb_build_object(
                           'ordinal', ordinal,
                           'configuration_id', configuration_id,
                           'source_class', source_class,
                           'configuration_hash', configuration_hash
                       ) ORDER BY ordinal)::text, '[]'), 'UTF8'), 'sha256'), 'hex')
              INTO configuration_count, configuration_min, configuration_max,
                   frozen_configuration_hash
              FROM public.campaign_assurance_run_configurations
             WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id;

            SELECT count(*)::integer,
                   COALESCE(min(ordinal), 0)::integer,
                   COALESCE(max(ordinal), 0)::integer,
                   pg_catalog.encode(public.digest(pg_catalog.convert_to(
                       COALESCE(jsonb_agg(jsonb_build_object(
                           'ordinal', ordinal,
                           'artifact_id', artifact_id::text,
                           'configuration_id', configuration_id,
                           'source_class', source_class,
                           'configuration_hash', configuration_hash,
                           'outbound_mime_hash', outbound_mime_hash
                       ) ORDER BY ordinal)::text, '[]'), 'UTF8'), 'sha256'), 'hex')
              INTO target_count, target_min, target_max, frozen_target_hash
              FROM public.campaign_assurance_run_targets
             WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id;

            IF artifact_count <> OLD.required_scenario_count OR
               artifact_min <> 1 OR artifact_max <> artifact_count OR
               configuration_count <> OLD.required_configuration_count OR
               configuration_min <> 1 OR configuration_max <> configuration_count OR
               target_count <> OLD.required_extraction_count OR
               target_min <> 1 OR target_max <> target_count THEN
                RAISE EXCEPTION 'campaign assurance snapshot manifest is incomplete or non-contiguous'
                    USING ERRCODE = '55000';
            END IF;

            NEW.artifact_set_hash := frozen_artifact_hash;
            NEW.configuration_manifest_hash := frozen_configuration_hash;
            NEW.target_manifest_hash := frozen_target_hash;
        ELSIF OLD.state = 'running' THEN
            IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
                RAISE EXCEPTION 'campaign assurance lease renewal requires worker scope'
                    USING ERRCODE = '42501';
            END IF;
            allowed_fields := ARRAY['lease_expires_at', 'heartbeat_at', 'updated_at'];
            IF OLD.lease_expires_at <= statement_timestamp() OR
               NEW.heartbeat_at <= OLD.heartbeat_at OR
               NEW.lease_expires_at <= NEW.heartbeat_at OR
               NEW.lease_expires_at <= OLD.lease_expires_at THEN
                RAISE EXCEPTION 'campaign assurance lease renewal must advance monotonically'
                    USING ERRCODE = '55000';
            END IF;
        ELSE
            RAISE EXCEPTION 'campaign assurance lifecycle is append-only'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.state = 'queued' AND NEW.state = 'running' THEN
        IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'campaign assurance claim requires worker scope'
                USING ERRCODE = '42501';
        END IF;
        allowed_fields := ARRAY[
            'state', 'claim_token', 'lease_owner', 'lease_expires_at',
            'heartbeat_at', 'attempt_count', 'retry_not_before', 'error_code',
            'error_message', 'started_at', 'updated_at'
        ];
        IF OLD.snapshot_frozen_at IS NULL OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
            RAISE EXCEPTION 'campaign assurance claim requires a frozen snapshot and next attempt'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.state = 'running' AND NEW.state = 'queued' THEN
        IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'campaign assurance retry requires worker scope'
                USING ERRCODE = '42501';
        END IF;
        allowed_fields := ARRAY[
            'state', 'claim_token', 'lease_owner', 'lease_expires_at',
            'heartbeat_at', 'retry_not_before', 'error_code', 'error_message',
            'updated_at'
        ];
        IF NEW.retry_not_before IS NULL THEN
            RAISE EXCEPTION 'requeued campaign assurance run must record retry_not_before'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.state = 'running' AND NEW.state IN ('complete', 'incomplete', 'failed') THEN
        IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'campaign assurance terminal receipt requires worker scope'
                USING ERRCODE = '42501';
        END IF;
        allowed_fields := ARRAY[
            'state', 'claim_token', 'lease_owner', 'lease_expires_at',
            'heartbeat_at', 'retry_not_before', 'terminal_extraction_count',
            'successful_extraction_count', 'extraction_error_count',
            'finding_count', 'blocking_finding_count', 'component_scores',
            'overall_score', 'score_min', 'score_max', 'score_spread',
            'agreement', 'gate_decision', 'input_tokens', 'output_tokens',
            'cost_microunits', 'latency_ms', 'error_code', 'error_message',
            'completed_at', 'updated_at'
        ];

        -- Terminal aggregates are database facts, never caller assertions.
        -- The run row is already locked by the UPDATE; evidence insert guards
        -- take FOR SHARE on that same row, so no receipt can race this proof.
        SELECT count(extractions.id)::integer,
               count(extractions.id) FILTER (
                   WHERE extractions.status = 'complete'
               )::integer,
               count(extractions.id) FILTER (
                   WHERE extractions.status IN ('error', 'unavailable')
               )::integer,
               COALESCE(sum(extractions.input_tokens), 0)::bigint,
               COALESCE(sum(extractions.output_tokens), 0)::bigint,
               COALESCE(sum(extractions.cost_microunits), 0)::bigint,
               COALESCE(sum(extractions.latency_ms), 0)::bigint
          INTO actual_terminal, actual_successful, actual_errors,
               actual_input_tokens, actual_output_tokens,
               actual_cost_microunits, actual_latency_ms
          FROM public.campaign_assurance_run_targets AS targets
          LEFT JOIN public.campaign_assurance_extractions AS extractions
            ON extractions.tenant_id = targets.tenant_id
           AND extractions.run_id = targets.run_id
           AND extractions.artifact_id = targets.artifact_id
           AND extractions.configuration_id = targets.configuration_id
           AND extractions.attempt_count = OLD.attempt_count
         WHERE targets.tenant_id = OLD.tenant_id
           AND targets.run_id = OLD.id;

        SELECT count(*)::integer,
               count(*) FILTER (WHERE blocking)::integer
          INTO actual_findings, actual_blocking
          FROM public.campaign_assurance_findings
         WHERE tenant_id = OLD.tenant_id
           AND run_id = OLD.id
           AND attempt_count = OLD.attempt_count;

        NEW.terminal_extraction_count := actual_terminal;
        NEW.successful_extraction_count := actual_successful;
        NEW.extraction_error_count := actual_errors;
        NEW.finding_count := actual_findings;
        NEW.blocking_finding_count := actual_blocking;
        NEW.input_tokens := actual_input_tokens;
        NEW.output_tokens := actual_output_tokens;
        NEW.cost_microunits := actual_cost_microunits;
        NEW.latency_ms := actual_latency_ms;

        IF NEW.state = 'complete' AND (
            actual_terminal <> OLD.required_extraction_count OR
            actual_successful <> OLD.required_extraction_count OR
            actual_errors <> 0
        ) THEN
            RAISE EXCEPTION 'complete campaign assurance run requires every persisted target receipt'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.state = 'incomplete' AND
           actual_terminal = OLD.required_extraction_count AND
           actual_successful = OLD.required_extraction_count AND
           actual_errors = 0 THEN
            RAISE EXCEPTION 'fully covered campaign assurance run cannot be marked incomplete'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.state = 'complete' AND actual_blocking > 0 AND
           NEW.gate_decision <> 'block' THEN
            RAISE EXCEPTION 'blocking findings require a blocked gate decision'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.state = 'complete' AND actual_blocking = 0 AND
           NEW.gate_decision = 'block' THEN
            RAISE EXCEPTION 'blocked gate decision requires a persisted blocking finding'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.state IN ('incomplete', 'failed') AND
           NEW.gate_decision <> 'unavailable' THEN
            RAISE EXCEPTION 'non-complete campaign assurance run cannot issue a gate decision'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.state IN ('queued', 'running') AND NEW.state = 'cancelled' THEN
        allowed_fields := ARRAY[
            'state', 'claim_token', 'lease_owner', 'lease_expires_at',
            'heartbeat_at', 'retry_not_before', 'gate_decision', 'completed_at',
            'cancelled_at', 'updated_at'
        ];
    ELSIF OLD.state IN ('queued', 'running') AND NEW.state = 'stale' THEN
        allowed_fields := ARRAY[
            'state', 'claim_token', 'lease_owner', 'lease_expires_at',
            'heartbeat_at', 'retry_not_before', 'completed_at', 'stale_at',
            'updated_at'
        ];
    ELSIF OLD.state IN ('complete', 'incomplete') AND NEW.state = 'stale' THEN
        allowed_fields := ARRAY['state', 'stale_at', 'updated_at'];
    ELSE
        RAISE EXCEPTION 'invalid campaign assurance run transition: % -> %', OLD.state, NEW.state
            USING ERRCODE = '55000';
    END IF;

    IF (to_jsonb(NEW) - allowed_fields) IS DISTINCT FROM
       (to_jsonb(OLD) - allowed_fields) THEN
        RAISE EXCEPTION 'campaign assurance transition attempted to rewrite frozen evidence'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_runs_lifecycle_guard
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_runs
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_runs_guard();

CREATE TRIGGER campaign_assurance_runs_set_updated_at
    BEFORE UPDATE ON campaign_assurance_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION campaign_assurance_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    parent_state text;
    frozen_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT state, snapshot_frozen_at
          INTO parent_state, frozen_at
          FROM public.campaign_assurance_runs AS runs
         WHERE tenant_id = NEW.tenant_id
           AND campaign_id = NEW.campaign_id
           AND id = NEW.run_id
         FOR SHARE;
        IF NOT FOUND OR parent_state <> 'queued' OR frozen_at IS NOT NULL THEN
            RAISE EXCEPTION 'campaign assurance input snapshot is frozen'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.campaign_assurance_runs
         WHERE tenant_id = OLD.tenant_id AND id = OLD.run_id
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'campaign assurance input snapshots are immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_run_artifacts_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_run_artifacts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_snapshot_guard();

CREATE TRIGGER campaign_assurance_run_configurations_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_run_configurations
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_snapshot_guard();

CREATE TRIGGER campaign_assurance_run_targets_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_run_targets
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_snapshot_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_worker_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    parent_state text;
    parent_attempt integer;
    parent_claim_token uuid;
    parent_lease_expires_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'campaign assurance evidence insertion requires worker scope'
                USING ERRCODE = '42501';
        END IF;
        SELECT state, attempt_count, claim_token, lease_expires_at
          INTO parent_state, parent_attempt, parent_claim_token, parent_lease_expires_at
          FROM public.campaign_assurance_runs
         WHERE tenant_id = NEW.tenant_id
           AND campaign_id = NEW.campaign_id
           AND id = NEW.run_id
         FOR SHARE;
        IF NOT FOUND OR parent_state <> 'running' OR
           parent_attempt <> NEW.attempt_count OR
           parent_claim_token <> NEW.claim_token OR
           parent_lease_expires_at <= statement_timestamp() THEN
            RAISE EXCEPTION 'campaign assurance evidence does not belong to the active attempt'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.campaign_assurance_runs
         WHERE tenant_id = OLD.tenant_id AND id = OLD.run_id
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'campaign assurance worker evidence is immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_extractions_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_extractions
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_worker_evidence_guard();

CREATE TRIGGER campaign_assurance_findings_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_findings
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_worker_evidence_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_overrides_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    parent_state text;
    parent_attempt integer;
    parent_artifact_hash text;
    parent_gate_decision text;
    finding_blocking boolean;
    finding_overridable boolean;
    bound_actor_id uuid;
    verified_actor_role text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        bound_actor_id := NULLIF(current_setting('app.user_id', true), '')::uuid;
        IF bound_actor_id IS NULL OR NEW.actor_id <> bound_actor_id THEN
            RAISE EXCEPTION 'campaign assurance override requires the bound acting user'
                USING ERRCODE = '42501';
        END IF;
        SELECT role
          INTO verified_actor_role
          FROM public.users
         WHERE tenant_id = NEW.tenant_id
           AND id = bound_actor_id
           AND role IN ('owner', 'admin')
         FOR SHARE;
        IF NOT FOUND OR NEW.actor_role <> verified_actor_role THEN
            RAISE EXCEPTION 'campaign assurance override requires a current tenant owner or admin'
                USING ERRCODE = '42501';
        END IF;

        SELECT runs.state, runs.attempt_count, runs.artifact_set_hash,
               runs.gate_decision, findings.blocking, findings.overridable
          INTO parent_state, parent_attempt, parent_artifact_hash,
               parent_gate_decision, finding_blocking, finding_overridable
          FROM public.campaign_assurance_runs AS runs
          JOIN public.campaign_assurance_findings AS findings
            ON findings.tenant_id = runs.tenant_id
           AND findings.campaign_id = runs.campaign_id
           AND findings.run_id = runs.id
           AND findings.attempt_count = runs.attempt_count
           AND findings.id = NEW.finding_id
           AND findings.receipt_hash = NEW.finding_receipt_hash
         WHERE runs.tenant_id = NEW.tenant_id
           AND runs.campaign_id = NEW.campaign_id
           AND runs.id = NEW.run_id
         FOR SHARE OF runs, findings;
        IF NOT FOUND OR parent_state NOT IN ('complete', 'incomplete') OR
           parent_attempt <> NEW.attempt_count OR
           parent_artifact_hash <> NEW.artifact_set_hash THEN
            RAISE EXCEPTION 'campaign assurance override does not match terminal run evidence'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.decision = 'allow_send' AND (
            parent_state <> 'complete' OR parent_gate_decision <> 'block' OR
            finding_blocking IS NOT TRUE OR finding_overridable IS NOT TRUE
        ) THEN
            RAISE EXCEPTION 'campaign assurance finding is not eligible for allow-send override'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.campaign_assurance_runs
         WHERE tenant_id = OLD.tenant_id AND id = OLD.run_id
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'campaign assurance overrides are immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_overrides_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_overrides
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_overrides_guard();

-- Tenant isolation is restrictive even for workers. A worker must bind both
-- app.tenant_id and app.outbox_worker; the generic worker capability never
-- becomes a cross-tenant table-enumeration bypass. Durable command delivery
-- supplies the tenant/run identity that a worker claims.
ALTER TABLE campaign_assurance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_runs_scope_boundary ON campaign_assurance_runs
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_runs_tenant_select ON campaign_assurance_runs
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_runs_tenant_insert ON campaign_assurance_runs
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Tenant-scoped lifecycle commands may freeze, cancel, or mark evidence stale.
-- The lifecycle trigger separately requires app.outbox_worker for claim,
-- heartbeat, retry, finalization, and failure transitions.
CREATE POLICY campaign_assurance_runs_tenant_update ON campaign_assurance_runs
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_runs_worker_access ON campaign_assurance_runs
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_runs_worker_update ON campaign_assurance_runs
    FOR UPDATE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_run_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_run_artifacts_scope_boundary ON campaign_assurance_run_artifacts
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_artifacts_tenant_select ON campaign_assurance_run_artifacts
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_artifacts_tenant_insert ON campaign_assurance_run_artifacts
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_artifacts_worker_select ON campaign_assurance_run_artifacts
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_run_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_run_configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_run_configurations_scope_boundary ON campaign_assurance_run_configurations
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_configurations_tenant_select ON campaign_assurance_run_configurations
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_configurations_tenant_insert ON campaign_assurance_run_configurations
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_configurations_worker_select ON campaign_assurance_run_configurations
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_run_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_run_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_run_targets_scope_boundary ON campaign_assurance_run_targets
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_targets_tenant_select ON campaign_assurance_run_targets
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_targets_tenant_insert ON campaign_assurance_run_targets
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_run_targets_worker_select ON campaign_assurance_run_targets
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_extractions FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_extractions_scope_boundary ON campaign_assurance_extractions
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_extractions_tenant_select ON campaign_assurance_extractions
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_extractions_worker_select ON campaign_assurance_extractions
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_extractions_worker_insert ON campaign_assurance_extractions
    FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_findings_scope_boundary ON campaign_assurance_findings
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_findings_tenant_select ON campaign_assurance_findings
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_findings_worker_select ON campaign_assurance_findings
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_findings_worker_insert ON campaign_assurance_findings
    FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_overrides_scope_boundary ON campaign_assurance_overrides
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_overrides_tenant_select ON campaign_assurance_overrides
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_overrides_principal_insert ON campaign_assurance_overrides
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND actor_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM users
             WHERE users.tenant_id = campaign_assurance_overrides.tenant_id
               AND users.id = campaign_assurance_overrides.actor_id
               AND users.role IN ('owner', 'admin')
        )
    );

GRANT SELECT, INSERT, UPDATE ON campaign_assurance_runs TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_run_artifacts TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_run_configurations TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_run_targets TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_extractions TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_findings TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_overrides TO postwave_app;

REVOKE DELETE, TRUNCATE ON campaign_assurance_runs FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_run_artifacts FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_run_configurations FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_run_targets FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_extractions FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_findings FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_overrides FROM postwave_app;

COMMENT ON TABLE campaign_assurance_runs IS
    'Gateway-owned durable Predicted Agent Comprehension lifecycle bound to exact immutable campaign artifacts.';
COMMENT ON TABLE campaign_assurance_run_artifacts IS
    'Immutable required scenario/artifact manifest frozen before an assurance worker can claim the run.';
COMMENT ON TABLE campaign_assurance_run_configurations IS
    'Immutable closed analyzer configuration suite; repeated model calls measure simulator robustness, not provider variance.';
COMMENT ON TABLE campaign_assurance_run_targets IS
    'Immutable sparse artifact-by-configuration target matrix that defines complete analyzer coverage.';
COMMENT ON TABLE campaign_assurance_extractions IS
    'Attempt-scoped immutable structured analyzer receipts with bounded encrypted raw-output references.';
COMMENT ON TABLE campaign_assurance_findings IS
    'Stable immutable deterministic/modeled/observed findings; a campaign-level average cannot erase a failed scenario.';
COMMENT ON TABLE campaign_assurance_overrides IS
    'Append-only governance decisions that coexist with, and never mutate, the underlying finding.';

COMMIT;
