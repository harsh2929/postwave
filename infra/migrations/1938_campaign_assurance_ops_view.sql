-- 1938_campaign_assurance_ops_view.sql
--
-- Content-free, cross-tenant support views for Campaign Assurance. Operators
-- need enough metadata to diagnose lifecycle, retry, capability, freshness,
-- provider-cost, and cache-reuse failures without receiving campaign content
-- or provider payloads. The function return types are the disclosure boundary:
-- no subject/body, normalized extraction, raw output/object reference, prompt
-- text, provider payload, mailbox/recipient identity, error message, or secret
-- is selected or returned.
--
-- postwave_ops retains no base-table access. A purpose-built NOLOGIN,
-- NOBYPASSRLS definer owns these three reviewed SECURITY DEFINER functions,
-- receives SELECT only on the exact metadata columns referenced below, and is
-- admitted by explicit SELECT-only RLS policies on those tables.
--
-- rollback-strategy: no-op. These additive read functions may be in use by a
-- newer ops binary during rollback; revert the binary first, then remove the
-- functions and the dedicated role only after confirming there are no callers.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'postwave_campaign_assurance_ops_definer'
    ) THEN
        CREATE ROLE postwave_campaign_assurance_ops_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;

    SELECT * INTO definer
      FROM pg_roles
     WHERE rolname = 'postwave_campaign_assurance_ops_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_campaign_assurance_ops_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_campaign_assurance_ops_definer must have no memberships or members';
    END IF;
    IF has_schema_privilege('postwave_ops', 'public', 'CREATE') OR
       has_schema_privilege(
           'postwave_campaign_assurance_ops_definer', 'public', 'CREATE'
       ) THEN
        RAISE EXCEPTION
            'Campaign Assurance ops roles must not hold CREATE on schema public';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
               'ops_campaign_assurance_runs',
               'ops_campaign_assurance_run_detail',
               'ops_campaign_assurance_run_timeline'
           )
    ) THEN
        RAISE EXCEPTION
            'Campaign Assurance ops function exists out of band; remove and audit it before retrying';
    END IF;
END;
$$;

-- Reset a pre-provisioned purpose role before installing the reviewed grants.
-- CREATE is temporary and exists only so PostgreSQL permits the ownership
-- hand-off later in this transaction.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_campaign_assurance_ops_definer;
GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (
    id, tenant_id, campaign_id, content_revision_id, send_plan_id, run_no,
    trigger_kind, profile, state,
    source_hash, plan_hash, artifact_set_hash, coverage_manifest_hash,
    configuration_manifest_hash, target_manifest_hash,
    renderer_version, compiler_version, fixture_set_version,
    plan_policy_version, analyzer_suite_version, model_suite_version,
    prompt_suite_version, prompt_suite_hash, normalization_version,
    scoring_version, gate_policy_version, methodology_version,
    required_scenario_count, required_configuration_count,
    required_extraction_count, terminal_extraction_count,
    successful_extraction_count, extraction_error_count, finding_count,
    blocking_finding_count, gate_decision, input_tokens, output_tokens,
    cost_microunits, max_modeled_cost_microunits,
    snapshot_frozen_at, lease_expires_at, heartbeat_at, attempt_count,
    max_attempts, retry_not_before, error_code, created_at, started_at,
    completed_at, cancelled_at, stale_at, updated_at
) ON public.campaign_assurance_runs
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (
    tenant_id, run_id, available_at, lease_expires_at,
    delivery_attempt_count, last_delivered_at, completed_at
) ON public.campaign_assurance_commands
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (tenant_id, run_id, source_class)
    ON public.campaign_assurance_run_targets
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (
    tenant_id, run_id, attempt_count,
    raw_output_expires_at, execution_kind, reused_original_cost_microunits
) ON public.campaign_assurance_extractions
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (tenant_id, run_id, invocation_id, reserved_microunits)
    ON public.campaign_assurance_model_invocation_reservations
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (tenant_id, run_id, invocation_id, status)
    ON public.campaign_assurance_model_invocation_results
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (
    tenant_id, campaign_id, send_plan_id, source_class,
    observed_surface_type, health_state, captured_at, expires_at
) ON public.seed_message_observations
    TO postwave_campaign_assurance_ops_definer;

GRANT SELECT (
    tenant_id, campaign_id, run_id, event_no, event_id, attempt_count,
    event_type, stage, status, entity_id, artifact_id, configuration_id,
    receipt_hash, occurred_at
) ON public.campaign_assurance_progress_events
    TO postwave_campaign_assurance_ops_definer;

-- Every source table FORCEs RLS. Cross-tenant access is therefore explicit in
-- policy inventory as well as in column grants; the function owner does not
-- possess BYPASSRLS and cannot use an omitted table without a reviewed policy.
CREATE POLICY campaign_assurance_runs_ops_support_select
    ON public.campaign_assurance_runs
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY campaign_assurance_commands_ops_support_select
    ON public.campaign_assurance_commands
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY campaign_assurance_run_targets_ops_support_select
    ON public.campaign_assurance_run_targets
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY campaign_assurance_extractions_ops_support_select
    ON public.campaign_assurance_extractions
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY campaign_assurance_model_reservations_ops_support_select
    ON public.campaign_assurance_model_invocation_reservations
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY campaign_assurance_model_results_ops_support_select
    ON public.campaign_assurance_model_invocation_results
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY seed_message_observations_ops_support_select
    ON public.seed_message_observations
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);
CREATE POLICY campaign_assurance_progress_events_ops_support_select
    ON public.campaign_assurance_progress_events
    FOR SELECT TO postwave_campaign_assurance_ops_definer
    USING (true);

-- Fleet list, newest first. The keyset cursor is an inseparable
-- (created_at,run_id) pair. p_limit is the requested response size; one extra
-- row is intentionally returned so the application can produce an exact next
-- cursor without an unbounded count query.
CREATE FUNCTION public.ops_campaign_assurance_runs(
    p_tenant_id uuid,
    p_state text,
    p_before_created_at timestamptz,
    p_before_run_id uuid,
    p_limit integer
)
RETURNS TABLE (
    tenant_id text,
    campaign_id text,
    run_id text,
    run_no bigint,
    trigger_kind text,
    profile text,
    state text,
    gate_decision text,
    attempt_count integer,
    max_attempts integer,
    retry_not_before timestamptz,
    error_code text,
    required_extraction_count integer,
    terminal_extraction_count integer,
    extraction_error_count integer,
    blocking_finding_count integer,
    deterministic_target_count bigint,
    modeled_target_count bigint,
    controlled_observation_target_count bigint,
    input_tokens bigint,
    output_tokens bigint,
    cost_microunits bigint,
    max_modeled_cost_microunits bigint,
    invoked_extraction_count bigint,
    cache_reuse_count bigint,
    live_raw_evidence_count bigint,
    expired_raw_evidence_count bigint,
    next_raw_evidence_expiry timestamptz,
    seed_observation_count bigint,
    latest_seed_observation_at timestamptz,
    next_seed_observation_expiry timestamptz,
    command_delivery_attempt_count integer,
    command_available_at timestamptz,
    command_lease_expires_at timestamptz,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    snapshot_frozen_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    completed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;
    IF p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
        RAISE EXCEPTION 'p_tenant_id must be null or a non-zero UUID'
            USING ERRCODE = '22023';
    END IF;
    IF p_state IS NOT NULL AND p_state NOT IN (
        'queued', 'running', 'complete', 'incomplete',
        'failed', 'cancelled', 'stale'
    ) THEN
        RAISE EXCEPTION 'p_state is not a Campaign Assurance run state'
            USING ERRCODE = '22023';
    END IF;
    IF (p_before_created_at IS NULL) <> (p_before_run_id IS NULL) OR
       p_before_run_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
        RAISE EXCEPTION 'the keyset cursor must be a complete non-zero pair'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT runs.id,
               runs.tenant_id,
               runs.campaign_id,
               runs.send_plan_id,
               runs.run_no,
               runs.trigger_kind,
               runs.profile,
               runs.state,
               runs.gate_decision,
               runs.attempt_count,
               runs.max_attempts,
               runs.retry_not_before,
               runs.error_code,
               runs.required_extraction_count,
               runs.terminal_extraction_count,
               runs.extraction_error_count,
               runs.blocking_finding_count,
               runs.input_tokens,
               runs.output_tokens,
               runs.cost_microunits,
               runs.max_modeled_cost_microunits,
               runs.lease_expires_at,
               runs.heartbeat_at,
               runs.snapshot_frozen_at,
               runs.created_at,
               runs.updated_at,
               runs.completed_at
          FROM public.campaign_assurance_runs AS runs
         WHERE (p_tenant_id IS NULL OR runs.tenant_id = p_tenant_id)
           AND (p_state IS NULL OR runs.state = p_state)
           AND (
               p_before_created_at IS NULL OR
               (runs.created_at, runs.id) <
                   (p_before_created_at, p_before_run_id)
           )
         ORDER BY runs.created_at DESC, runs.id DESC
         LIMIT p_limit + 1
    )
    SELECT runs.tenant_id::text,
           runs.campaign_id::text,
           runs.id::text,
           runs.run_no,
           runs.trigger_kind,
           runs.profile,
           runs.state,
           runs.gate_decision,
           runs.attempt_count,
           runs.max_attempts,
           runs.retry_not_before,
           runs.error_code,
           runs.required_extraction_count,
           runs.terminal_extraction_count,
           runs.extraction_error_count,
           runs.blocking_finding_count,
           capabilities.deterministic_target_count,
           capabilities.modeled_target_count,
           capabilities.controlled_observation_target_count,
           runs.input_tokens,
           runs.output_tokens,
           runs.cost_microunits,
           runs.max_modeled_cost_microunits,
           evidence.invoked_extraction_count,
           evidence.cache_reuse_count,
           evidence.live_raw_evidence_count,
           evidence.expired_raw_evidence_count,
           evidence.next_raw_evidence_expiry,
           observations.seed_observation_count,
           observations.latest_seed_observation_at,
           observations.next_seed_observation_expiry,
           COALESCE(commands.delivery_attempt_count, 0),
           commands.available_at,
           commands.lease_expires_at,
           runs.lease_expires_at,
           runs.heartbeat_at,
           runs.snapshot_frozen_at,
           runs.created_at,
           runs.updated_at,
           runs.completed_at
      FROM candidates AS runs
      LEFT JOIN public.campaign_assurance_commands AS commands
        ON commands.tenant_id = runs.tenant_id
       AND commands.run_id = runs.id
      LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (
                     WHERE targets.source_class = 'deterministic'
                 )::bigint AS deterministic_target_count,
                 COUNT(*) FILTER (
                     WHERE targets.source_class = 'modeled'
                 )::bigint AS modeled_target_count,
                 COUNT(*) FILTER (
                     WHERE targets.source_class = 'controlled_observation'
                 )::bigint AS controlled_observation_target_count
            FROM public.campaign_assurance_run_targets AS targets
           WHERE targets.tenant_id = runs.tenant_id
             AND targets.run_id = runs.id
      ) AS capabilities ON true
      LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (
                     WHERE extractions.execution_kind = 'invoked'
                 )::bigint AS invoked_extraction_count,
                 COUNT(*) FILTER (
                     WHERE extractions.execution_kind = 'cache_reuse'
                 )::bigint AS cache_reuse_count,
                 COUNT(*) FILTER (
                     WHERE extractions.raw_output_expires_at > statement_timestamp()
                 )::bigint AS live_raw_evidence_count,
                 COUNT(*) FILTER (
                     WHERE extractions.raw_output_expires_at IS NOT NULL
                       AND extractions.raw_output_expires_at <= statement_timestamp()
                 )::bigint AS expired_raw_evidence_count,
                 MIN(extractions.raw_output_expires_at) FILTER (
                     WHERE extractions.raw_output_expires_at > statement_timestamp()
                 ) AS next_raw_evidence_expiry
            FROM public.campaign_assurance_extractions AS extractions
           WHERE extractions.tenant_id = runs.tenant_id
             AND extractions.run_id = runs.id
             AND extractions.attempt_count = runs.attempt_count
      ) AS evidence ON true
      LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS seed_observation_count,
                 MAX(seed.captured_at) AS latest_seed_observation_at,
                 MIN(seed.expires_at) FILTER (
                     WHERE seed.expires_at > statement_timestamp()
                 ) AS next_seed_observation_expiry
            FROM public.seed_message_observations AS seed
           WHERE seed.tenant_id = runs.tenant_id
             AND seed.campaign_id = runs.campaign_id
             AND seed.send_plan_id = runs.send_plan_id
      ) AS observations ON true
     ORDER BY runs.created_at DESC, runs.id DESC;
END;
$$;

-- One exact run with immutable provenance plus bounded aggregate diagnostics.
-- Safe error codes are returned; human/provider error messages are not.
CREATE FUNCTION public.ops_campaign_assurance_run_detail(p_run_id uuid)
RETURNS TABLE (
    tenant_id text,
    campaign_id text,
    run_id text,
    run_no bigint,
    trigger_kind text,
    profile text,
    state text,
    gate_decision text,
    attempt_count integer,
    max_attempts integer,
    retry_not_before timestamptz,
    error_code text,
    required_extraction_count integer,
    terminal_extraction_count integer,
    extraction_error_count integer,
    blocking_finding_count integer,
    deterministic_target_count bigint,
    modeled_target_count bigint,
    controlled_observation_target_count bigint,
    input_tokens bigint,
    output_tokens bigint,
    cost_microunits bigint,
    max_modeled_cost_microunits bigint,
    invoked_extraction_count bigint,
    cache_reuse_count bigint,
    live_raw_evidence_count bigint,
    expired_raw_evidence_count bigint,
    next_raw_evidence_expiry timestamptz,
    seed_observation_count bigint,
    latest_seed_observation_at timestamptz,
    next_seed_observation_expiry timestamptz,
    command_delivery_attempt_count integer,
    command_available_at timestamptz,
    command_lease_expires_at timestamptz,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    snapshot_frozen_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    completed_at timestamptz,
    content_revision_id text,
    send_plan_id text,
    source_hash text,
    plan_hash text,
    artifact_set_hash text,
    coverage_manifest_hash text,
    configuration_manifest_hash text,
    target_manifest_hash text,
    renderer_version text,
    compiler_version text,
    fixture_set_version text,
    plan_policy_version text,
    analyzer_suite_version text,
    model_suite_version text,
    prompt_suite_version text,
    prompt_suite_hash text,
    normalization_version text,
    scoring_version text,
    gate_policy_version text,
    methodology_version text,
    required_scenario_count integer,
    required_configuration_count integer,
    successful_extraction_count integer,
    finding_count integer,
    reused_original_cost_microunits bigint,
    model_reservation_count bigint,
    reserved_cost_microunits bigint,
    settled_model_invocation_count bigint,
    charge_unknown_count bigint,
    raw_evidence_count bigint,
    latest_raw_evidence_expiry timestamptz,
    controlled_client_observation_count bigint,
    observed_surface_count bigint,
    unhealthy_observation_count bigint,
    expired_seed_observation_count bigint,
    command_last_delivered_at timestamptz,
    command_completed_at timestamptz,
    started_at timestamptz,
    cancelled_at timestamptz,
    stale_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_run_id IS NULL OR
       p_run_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
        RAISE EXCEPTION 'p_run_id must be a non-zero UUID'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT runs.tenant_id::text,
           runs.campaign_id::text,
           runs.id::text,
           runs.run_no,
           runs.trigger_kind,
           runs.profile,
           runs.state,
           runs.gate_decision,
           runs.attempt_count,
           runs.max_attempts,
           runs.retry_not_before,
           runs.error_code,
           runs.required_extraction_count,
           runs.terminal_extraction_count,
           runs.extraction_error_count,
           runs.blocking_finding_count,
           capabilities.deterministic_target_count,
           capabilities.modeled_target_count,
           capabilities.controlled_observation_target_count,
           runs.input_tokens,
           runs.output_tokens,
           runs.cost_microunits,
           runs.max_modeled_cost_microunits,
           evidence.invoked_extraction_count,
           evidence.cache_reuse_count,
           evidence.live_raw_evidence_count,
           evidence.expired_raw_evidence_count,
           evidence.next_raw_evidence_expiry,
           observations.seed_observation_count,
           observations.latest_seed_observation_at,
           observations.next_seed_observation_expiry,
           COALESCE(commands.delivery_attempt_count, 0),
           commands.available_at,
           commands.lease_expires_at,
           runs.lease_expires_at,
           runs.heartbeat_at,
           runs.snapshot_frozen_at,
           runs.created_at,
           runs.updated_at,
           runs.completed_at,
           runs.content_revision_id::text,
           runs.send_plan_id::text,
           runs.source_hash,
           runs.plan_hash,
           runs.artifact_set_hash,
           runs.coverage_manifest_hash,
           runs.configuration_manifest_hash,
           runs.target_manifest_hash,
           runs.renderer_version,
           runs.compiler_version,
           runs.fixture_set_version,
           runs.plan_policy_version,
           runs.analyzer_suite_version,
           runs.model_suite_version,
           runs.prompt_suite_version,
           runs.prompt_suite_hash,
           runs.normalization_version,
           runs.scoring_version,
           runs.gate_policy_version,
           runs.methodology_version,
           runs.required_scenario_count,
           runs.required_configuration_count,
           runs.successful_extraction_count,
           runs.finding_count,
           evidence.reused_original_cost_microunits,
           model_cost.model_reservation_count,
           model_cost.reserved_cost_microunits,
           model_cost.settled_model_invocation_count,
           model_cost.charge_unknown_count,
           evidence.raw_evidence_count,
           evidence.latest_raw_evidence_expiry,
           observations.controlled_client_observation_count,
           observations.observed_surface_count,
           observations.unhealthy_observation_count,
           observations.expired_seed_observation_count,
           commands.last_delivered_at,
           commands.completed_at,
           runs.started_at,
           runs.cancelled_at,
           runs.stale_at
      FROM public.campaign_assurance_runs AS runs
      LEFT JOIN public.campaign_assurance_commands AS commands
        ON commands.tenant_id = runs.tenant_id
       AND commands.run_id = runs.id
      LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (
                     WHERE targets.source_class = 'deterministic'
                 )::bigint AS deterministic_target_count,
                 COUNT(*) FILTER (
                     WHERE targets.source_class = 'modeled'
                 )::bigint AS modeled_target_count,
                 COUNT(*) FILTER (
                     WHERE targets.source_class = 'controlled_observation'
                 )::bigint AS controlled_observation_target_count
            FROM public.campaign_assurance_run_targets AS targets
           WHERE targets.tenant_id = runs.tenant_id
             AND targets.run_id = runs.id
      ) AS capabilities ON true
      LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (
                     WHERE extractions.execution_kind = 'invoked'
                 )::bigint AS invoked_extraction_count,
                 COUNT(*) FILTER (
                     WHERE extractions.execution_kind = 'cache_reuse'
                 )::bigint AS cache_reuse_count,
                 COALESCE(SUM(
                     extractions.reused_original_cost_microunits
                 ), 0)::bigint AS reused_original_cost_microunits,
                 COUNT(*) FILTER (
                     WHERE extractions.raw_output_expires_at IS NOT NULL
                 )::bigint AS raw_evidence_count,
                 COUNT(*) FILTER (
                     WHERE extractions.raw_output_expires_at > statement_timestamp()
                 )::bigint AS live_raw_evidence_count,
                 COUNT(*) FILTER (
                     WHERE extractions.raw_output_expires_at IS NOT NULL
                       AND extractions.raw_output_expires_at <= statement_timestamp()
                 )::bigint AS expired_raw_evidence_count,
                 MIN(extractions.raw_output_expires_at) FILTER (
                     WHERE extractions.raw_output_expires_at > statement_timestamp()
                 ) AS next_raw_evidence_expiry,
                 MAX(extractions.raw_output_expires_at)
                     AS latest_raw_evidence_expiry
            FROM public.campaign_assurance_extractions AS extractions
           WHERE extractions.tenant_id = runs.tenant_id
             AND extractions.run_id = runs.id
             AND extractions.attempt_count = runs.attempt_count
      ) AS evidence ON true
      LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS model_reservation_count,
                 COALESCE(SUM(reservations.reserved_microunits), 0)::bigint
                     AS reserved_cost_microunits,
                 COUNT(results.invocation_id)::bigint
                     AS settled_model_invocation_count,
                 COUNT(*) FILTER (
                     WHERE results.status = 'charge_unknown'
                 )::bigint AS charge_unknown_count
            FROM public.campaign_assurance_model_invocation_reservations
                 AS reservations
            LEFT JOIN public.campaign_assurance_model_invocation_results
                 AS results
              ON results.tenant_id = reservations.tenant_id
             AND results.run_id = reservations.run_id
             AND results.invocation_id = reservations.invocation_id
           WHERE reservations.tenant_id = runs.tenant_id
             AND reservations.run_id = runs.id
      ) AS model_cost ON true
      LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS seed_observation_count,
                 COUNT(*) FILTER (
                     WHERE seed.source_class = 'controlled_client'
                 )::bigint AS controlled_client_observation_count,
                 COUNT(*) FILTER (
                     WHERE seed.observed_surface_type IS NOT NULL
                 )::bigint AS observed_surface_count,
                 COUNT(*) FILTER (
                     WHERE seed.health_state <> 'active'
                 )::bigint AS unhealthy_observation_count,
                 COUNT(*) FILTER (
                     WHERE seed.expires_at <= statement_timestamp()
                 )::bigint AS expired_seed_observation_count,
                 MAX(seed.captured_at) AS latest_seed_observation_at,
                 MIN(seed.expires_at) FILTER (
                     WHERE seed.expires_at > statement_timestamp()
                 ) AS next_seed_observation_expiry
            FROM public.seed_message_observations AS seed
           WHERE seed.tenant_id = runs.tenant_id
             AND seed.campaign_id = runs.campaign_id
             AND seed.send_plan_id = runs.send_plan_id
      ) AS observations ON true
     WHERE runs.id = p_run_id;
END;
$$;

-- Content-free, event-number cursor. metadata is deliberately omitted because
-- it is an extensible JSON envelope and therefore not a durable disclosure
-- boundary even though current producers write only bounded operational data.
CREATE FUNCTION public.ops_campaign_assurance_run_timeline(
    p_run_id uuid,
    p_after_event_no bigint,
    p_limit integer
)
RETURNS TABLE (
    tenant_id text,
    campaign_id text,
    run_id text,
    event_no bigint,
    event_id text,
    attempt_count integer,
    event_type text,
    stage text,
    status text,
    entity_id text,
    artifact_id text,
    configuration_id text,
    receipt_hash text,
    occurred_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_run_id IS NULL OR
       p_run_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
        RAISE EXCEPTION 'p_run_id must be a non-zero UUID'
            USING ERRCODE = '22023';
    END IF;
    IF p_after_event_no IS NULL OR p_after_event_no < 0 THEN
        RAISE EXCEPTION 'p_after_event_no must be non-negative'
            USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT events.tenant_id::text,
           events.campaign_id::text,
           events.run_id::text,
           events.event_no,
           events.event_id::text,
           events.attempt_count,
           events.event_type,
           events.stage,
           events.status,
           events.entity_id::text,
           events.artifact_id::text,
           events.configuration_id,
           events.receipt_hash,
           events.occurred_at
      FROM public.campaign_assurance_progress_events AS events
     WHERE events.run_id = p_run_id
       AND events.event_no > p_after_event_no
     ORDER BY events.event_no
     LIMIT p_limit + 1;
END;
$$;

ALTER FUNCTION public.ops_campaign_assurance_runs(
    uuid, text, timestamptz, uuid, integer
) OWNER TO postwave_campaign_assurance_ops_definer;
ALTER FUNCTION public.ops_campaign_assurance_run_detail(uuid)
    OWNER TO postwave_campaign_assurance_ops_definer;
ALTER FUNCTION public.ops_campaign_assurance_run_timeline(uuid, bigint, integer)
    OWNER TO postwave_campaign_assurance_ops_definer;

REVOKE CREATE ON SCHEMA public
    FROM postwave_campaign_assurance_ops_definer;

REVOKE ALL ON FUNCTION public.ops_campaign_assurance_runs(
    uuid, text, timestamptz, uuid, integer
) FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_campaign_assurance_run_detail(uuid)
    FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_campaign_assurance_run_timeline(
    uuid, bigint, integer
) FROM PUBLIC, postwave_ops;

GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_runs(
    uuid, text, timestamptz, uuid, integer
) TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_run_detail(uuid)
    TO postwave_ops;
GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_run_timeline(
    uuid, bigint, integer
) TO postwave_ops;

COMMENT ON FUNCTION public.ops_campaign_assurance_runs(
    uuid, text, timestamptz, uuid, integer
) IS 'Content-free, bounded cross-tenant Campaign Assurance lifecycle inventory.';
COMMENT ON FUNCTION public.ops_campaign_assurance_run_detail(uuid)
IS 'Content-free Campaign Assurance provenance, capability, freshness, cost, and cache diagnostics.';
COMMENT ON FUNCTION public.ops_campaign_assurance_run_timeline(uuid, bigint, integer)
IS 'Content-free, bounded Campaign Assurance progress timeline; extensible event metadata is intentionally excluded.';

-- Fail the migration on owner, ACL, search-path, overload, role, or relation-
-- privilege drift. Security of this view is a database contract, not a caller
-- convention.
DO $$
DECLARE
    definer pg_roles%ROWTYPE;
    definer_oid oid;
    ops_oid oid;
BEGIN
    SELECT * INTO definer
      FROM pg_roles
     WHERE rolname = 'postwave_campaign_assurance_ops_definer';
    definer_oid := definer.oid;
    SELECT oid INTO ops_oid FROM pg_roles WHERE rolname = 'postwave_ops';

    IF definer_oid IS NULL OR ops_oid IS NULL THEN
        RAISE EXCEPTION 'required Campaign Assurance ops roles are missing';
    END IF;
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       definer.rolbypassrls THEN
        RAISE EXCEPTION 'Campaign Assurance ops definer attributes drifted';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_auth_members
         WHERE member = definer_oid OR roleid = definer_oid
    ) THEN
        RAISE EXCEPTION 'Campaign Assurance ops definer must remain isolated';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_policy AS policy
          JOIN pg_class AS relation ON relation.oid = policy.polrelid
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND policy.polname IN (
               'campaign_assurance_runs_ops_support_select',
               'campaign_assurance_commands_ops_support_select',
               'campaign_assurance_run_targets_ops_support_select',
               'campaign_assurance_extractions_ops_support_select',
               'campaign_assurance_model_reservations_ops_support_select',
               'campaign_assurance_model_results_ops_support_select',
               'seed_message_observations_ops_support_select',
               'campaign_assurance_progress_events_ops_support_select'
           )
           AND policy.polcmd = 'r'
           AND policy.polroles = ARRAY[definer_oid]::oid[]
           AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
           AND policy.polwithcheck IS NULL
    ) <> 8 THEN
        RAISE EXCEPTION 'Campaign Assurance ops RLS policy inventory is incomplete or unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_default_acl AS defaults
          CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
         WHERE acl.grantee = definer_oid
    ) THEN
        RAISE EXCEPTION 'default privileges expand the Campaign Assurance ops definer';
    END IF;
    IF NOT has_schema_privilege(
           'postwave_campaign_assurance_ops_definer', 'public', 'USAGE'
       ) OR has_schema_privilege(
           'postwave_campaign_assurance_ops_definer', 'public', 'CREATE'
       ) OR has_schema_privilege('postwave_ops', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'Campaign Assurance ops schema privileges are unsafe';
    END IF;

    IF to_regprocedure(
           'public.ops_campaign_assurance_runs(uuid,text,timestamp with time zone,uuid,integer)'
       ) IS NULL OR
       to_regprocedure(
           'public.ops_campaign_assurance_run_detail(uuid)'
       ) IS NULL OR
       to_regprocedure(
           'public.ops_campaign_assurance_run_timeline(uuid,bigint,integer)'
       ) IS NULL THEN
        RAISE EXCEPTION 'a reviewed Campaign Assurance ops function is missing';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
               'ops_campaign_assurance_runs',
               'ops_campaign_assurance_run_detail',
               'ops_campaign_assurance_run_timeline'
           )
    ) <> 3 THEN
        RAISE EXCEPTION 'unexpected Campaign Assurance ops overload exists';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          JOIN pg_language AS language ON language.oid = p.prolang
         WHERE n.nspname = 'public'
           AND p.proname IN (
               'ops_campaign_assurance_runs',
               'ops_campaign_assurance_run_detail',
               'ops_campaign_assurance_run_timeline'
           )
           AND (
               p.proowner <> definer_oid OR NOT p.prosecdef OR
               p.provolatile <> 's' OR p.prokind <> 'f' OR
               language.lanname <> 'plpgsql' OR
               p.proconfig IS DISTINCT FROM
                   ARRAY['search_path=pg_catalog']::text[]
           )
    ) THEN
        RAISE EXCEPTION 'Campaign Assurance ops function metadata is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
              COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
               'ops_campaign_assurance_runs',
               'ops_campaign_assurance_run_detail',
               'ops_campaign_assurance_run_timeline'
           )
           AND (
               acl.privilege_type <> 'EXECUTE' OR
               acl.grantee NOT IN (definer_oid, ops_oid) OR
               (acl.grantee = ops_oid AND acl.is_grantable)
           )
    ) THEN
        RAISE EXCEPTION 'Campaign Assurance ops function ACL is broader than reviewed';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
              COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
               'ops_campaign_assurance_runs',
               'ops_campaign_assurance_run_detail',
               'ops_campaign_assurance_run_timeline'
           )
           AND acl.grantee = ops_oid
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable
    ) <> 3 THEN
        RAISE EXCEPTION 'postwave_ops lacks an exact Campaign Assurance EXECUTE grant';
    END IF;

    IF EXISTS (
        WITH expected(table_name, column_name) AS (
            VALUES
              ('campaign_assurance_runs', 'id'),
              ('campaign_assurance_runs', 'tenant_id'),
              ('campaign_assurance_runs', 'campaign_id'),
              ('campaign_assurance_runs', 'content_revision_id'),
              ('campaign_assurance_runs', 'send_plan_id'),
              ('campaign_assurance_runs', 'run_no'),
              ('campaign_assurance_runs', 'trigger_kind'),
              ('campaign_assurance_runs', 'profile'),
              ('campaign_assurance_runs', 'state'),
              ('campaign_assurance_runs', 'source_hash'),
              ('campaign_assurance_runs', 'plan_hash'),
              ('campaign_assurance_runs', 'artifact_set_hash'),
              ('campaign_assurance_runs', 'coverage_manifest_hash'),
              ('campaign_assurance_runs', 'configuration_manifest_hash'),
              ('campaign_assurance_runs', 'target_manifest_hash'),
              ('campaign_assurance_runs', 'renderer_version'),
              ('campaign_assurance_runs', 'compiler_version'),
              ('campaign_assurance_runs', 'fixture_set_version'),
              ('campaign_assurance_runs', 'plan_policy_version'),
              ('campaign_assurance_runs', 'analyzer_suite_version'),
              ('campaign_assurance_runs', 'model_suite_version'),
              ('campaign_assurance_runs', 'prompt_suite_version'),
              ('campaign_assurance_runs', 'prompt_suite_hash'),
              ('campaign_assurance_runs', 'normalization_version'),
              ('campaign_assurance_runs', 'scoring_version'),
              ('campaign_assurance_runs', 'gate_policy_version'),
              ('campaign_assurance_runs', 'methodology_version'),
              ('campaign_assurance_runs', 'required_scenario_count'),
              ('campaign_assurance_runs', 'required_configuration_count'),
              ('campaign_assurance_runs', 'required_extraction_count'),
              ('campaign_assurance_runs', 'terminal_extraction_count'),
              ('campaign_assurance_runs', 'successful_extraction_count'),
              ('campaign_assurance_runs', 'extraction_error_count'),
              ('campaign_assurance_runs', 'finding_count'),
              ('campaign_assurance_runs', 'blocking_finding_count'),
              ('campaign_assurance_runs', 'gate_decision'),
              ('campaign_assurance_runs', 'input_tokens'),
              ('campaign_assurance_runs', 'output_tokens'),
              ('campaign_assurance_runs', 'cost_microunits'),
              ('campaign_assurance_runs', 'max_modeled_cost_microunits'),
              ('campaign_assurance_runs', 'snapshot_frozen_at'),
              ('campaign_assurance_runs', 'lease_expires_at'),
              ('campaign_assurance_runs', 'heartbeat_at'),
              ('campaign_assurance_runs', 'attempt_count'),
              ('campaign_assurance_runs', 'max_attempts'),
              ('campaign_assurance_runs', 'retry_not_before'),
              ('campaign_assurance_runs', 'error_code'),
              ('campaign_assurance_runs', 'created_at'),
              ('campaign_assurance_runs', 'started_at'),
              ('campaign_assurance_runs', 'completed_at'),
              ('campaign_assurance_runs', 'cancelled_at'),
              ('campaign_assurance_runs', 'stale_at'),
              ('campaign_assurance_runs', 'updated_at'),
              ('campaign_assurance_commands', 'tenant_id'),
              ('campaign_assurance_commands', 'run_id'),
              ('campaign_assurance_commands', 'available_at'),
              ('campaign_assurance_commands', 'lease_expires_at'),
              ('campaign_assurance_commands', 'delivery_attempt_count'),
              ('campaign_assurance_commands', 'last_delivered_at'),
              ('campaign_assurance_commands', 'completed_at'),
              ('campaign_assurance_run_targets', 'tenant_id'),
              ('campaign_assurance_run_targets', 'run_id'),
              ('campaign_assurance_run_targets', 'source_class'),
              ('campaign_assurance_extractions', 'tenant_id'),
              ('campaign_assurance_extractions', 'run_id'),
              ('campaign_assurance_extractions', 'attempt_count'),
              ('campaign_assurance_extractions', 'raw_output_expires_at'),
              ('campaign_assurance_extractions', 'execution_kind'),
              ('campaign_assurance_extractions', 'reused_original_cost_microunits'),
              ('campaign_assurance_model_invocation_reservations', 'tenant_id'),
              ('campaign_assurance_model_invocation_reservations', 'run_id'),
              ('campaign_assurance_model_invocation_reservations', 'invocation_id'),
              ('campaign_assurance_model_invocation_reservations', 'reserved_microunits'),
              ('campaign_assurance_model_invocation_results', 'tenant_id'),
              ('campaign_assurance_model_invocation_results', 'run_id'),
              ('campaign_assurance_model_invocation_results', 'invocation_id'),
              ('campaign_assurance_model_invocation_results', 'status'),
              ('seed_message_observations', 'tenant_id'),
              ('seed_message_observations', 'campaign_id'),
              ('seed_message_observations', 'send_plan_id'),
              ('seed_message_observations', 'source_class'),
              ('seed_message_observations', 'observed_surface_type'),
              ('seed_message_observations', 'health_state'),
              ('seed_message_observations', 'captured_at'),
              ('seed_message_observations', 'expires_at'),
              ('campaign_assurance_progress_events', 'tenant_id'),
              ('campaign_assurance_progress_events', 'campaign_id'),
              ('campaign_assurance_progress_events', 'run_id'),
              ('campaign_assurance_progress_events', 'event_no'),
              ('campaign_assurance_progress_events', 'event_id'),
              ('campaign_assurance_progress_events', 'attempt_count'),
              ('campaign_assurance_progress_events', 'event_type'),
              ('campaign_assurance_progress_events', 'stage'),
              ('campaign_assurance_progress_events', 'status'),
              ('campaign_assurance_progress_events', 'entity_id'),
              ('campaign_assurance_progress_events', 'artifact_id'),
              ('campaign_assurance_progress_events', 'configuration_id'),
              ('campaign_assurance_progress_events', 'receipt_hash'),
              ('campaign_assurance_progress_events', 'occurred_at')
        )
        SELECT 1
          FROM expected AS expected_column
         WHERE NOT has_column_privilege(
             'postwave_campaign_assurance_ops_definer',
             format('public.%I', expected_column.table_name),
             expected_column.column_name,
             'SELECT'
         )
    ) THEN
        RAISE EXCEPTION 'Campaign Assurance ops definer lacks a reviewed column grant';
    END IF;

    IF EXISTS (
        WITH expected(table_name, column_name) AS (
            VALUES
              ('campaign_assurance_runs', 'id'),
              ('campaign_assurance_runs', 'tenant_id'),
              ('campaign_assurance_runs', 'campaign_id'),
              ('campaign_assurance_runs', 'content_revision_id'),
              ('campaign_assurance_runs', 'send_plan_id'),
              ('campaign_assurance_runs', 'run_no'),
              ('campaign_assurance_runs', 'trigger_kind'),
              ('campaign_assurance_runs', 'profile'),
              ('campaign_assurance_runs', 'state'),
              ('campaign_assurance_runs', 'source_hash'),
              ('campaign_assurance_runs', 'plan_hash'),
              ('campaign_assurance_runs', 'artifact_set_hash'),
              ('campaign_assurance_runs', 'coverage_manifest_hash'),
              ('campaign_assurance_runs', 'configuration_manifest_hash'),
              ('campaign_assurance_runs', 'target_manifest_hash'),
              ('campaign_assurance_runs', 'renderer_version'),
              ('campaign_assurance_runs', 'compiler_version'),
              ('campaign_assurance_runs', 'fixture_set_version'),
              ('campaign_assurance_runs', 'plan_policy_version'),
              ('campaign_assurance_runs', 'analyzer_suite_version'),
              ('campaign_assurance_runs', 'model_suite_version'),
              ('campaign_assurance_runs', 'prompt_suite_version'),
              ('campaign_assurance_runs', 'prompt_suite_hash'),
              ('campaign_assurance_runs', 'normalization_version'),
              ('campaign_assurance_runs', 'scoring_version'),
              ('campaign_assurance_runs', 'gate_policy_version'),
              ('campaign_assurance_runs', 'methodology_version'),
              ('campaign_assurance_runs', 'required_scenario_count'),
              ('campaign_assurance_runs', 'required_configuration_count'),
              ('campaign_assurance_runs', 'required_extraction_count'),
              ('campaign_assurance_runs', 'terminal_extraction_count'),
              ('campaign_assurance_runs', 'successful_extraction_count'),
              ('campaign_assurance_runs', 'extraction_error_count'),
              ('campaign_assurance_runs', 'finding_count'),
              ('campaign_assurance_runs', 'blocking_finding_count'),
              ('campaign_assurance_runs', 'gate_decision'),
              ('campaign_assurance_runs', 'input_tokens'),
              ('campaign_assurance_runs', 'output_tokens'),
              ('campaign_assurance_runs', 'cost_microunits'),
              ('campaign_assurance_runs', 'max_modeled_cost_microunits'),
              ('campaign_assurance_runs', 'snapshot_frozen_at'),
              ('campaign_assurance_runs', 'lease_expires_at'),
              ('campaign_assurance_runs', 'heartbeat_at'),
              ('campaign_assurance_runs', 'attempt_count'),
              ('campaign_assurance_runs', 'max_attempts'),
              ('campaign_assurance_runs', 'retry_not_before'),
              ('campaign_assurance_runs', 'error_code'),
              ('campaign_assurance_runs', 'created_at'),
              ('campaign_assurance_runs', 'started_at'),
              ('campaign_assurance_runs', 'completed_at'),
              ('campaign_assurance_runs', 'cancelled_at'),
              ('campaign_assurance_runs', 'stale_at'),
              ('campaign_assurance_runs', 'updated_at'),
              ('campaign_assurance_commands', 'tenant_id'),
              ('campaign_assurance_commands', 'run_id'),
              ('campaign_assurance_commands', 'available_at'),
              ('campaign_assurance_commands', 'lease_expires_at'),
              ('campaign_assurance_commands', 'delivery_attempt_count'),
              ('campaign_assurance_commands', 'last_delivered_at'),
              ('campaign_assurance_commands', 'completed_at'),
              ('campaign_assurance_run_targets', 'tenant_id'),
              ('campaign_assurance_run_targets', 'run_id'),
              ('campaign_assurance_run_targets', 'source_class'),
              ('campaign_assurance_extractions', 'tenant_id'),
              ('campaign_assurance_extractions', 'run_id'),
              ('campaign_assurance_extractions', 'attempt_count'),
              ('campaign_assurance_extractions', 'raw_output_expires_at'),
              ('campaign_assurance_extractions', 'execution_kind'),
              ('campaign_assurance_extractions', 'reused_original_cost_microunits'),
              ('campaign_assurance_model_invocation_reservations', 'tenant_id'),
              ('campaign_assurance_model_invocation_reservations', 'run_id'),
              ('campaign_assurance_model_invocation_reservations', 'invocation_id'),
              ('campaign_assurance_model_invocation_reservations', 'reserved_microunits'),
              ('campaign_assurance_model_invocation_results', 'tenant_id'),
              ('campaign_assurance_model_invocation_results', 'run_id'),
              ('campaign_assurance_model_invocation_results', 'invocation_id'),
              ('campaign_assurance_model_invocation_results', 'status'),
              ('seed_message_observations', 'tenant_id'),
              ('seed_message_observations', 'campaign_id'),
              ('seed_message_observations', 'send_plan_id'),
              ('seed_message_observations', 'source_class'),
              ('seed_message_observations', 'observed_surface_type'),
              ('seed_message_observations', 'health_state'),
              ('seed_message_observations', 'captured_at'),
              ('seed_message_observations', 'expires_at'),
              ('campaign_assurance_progress_events', 'tenant_id'),
              ('campaign_assurance_progress_events', 'campaign_id'),
              ('campaign_assurance_progress_events', 'run_id'),
              ('campaign_assurance_progress_events', 'event_no'),
              ('campaign_assurance_progress_events', 'event_id'),
              ('campaign_assurance_progress_events', 'attempt_count'),
              ('campaign_assurance_progress_events', 'event_type'),
              ('campaign_assurance_progress_events', 'stage'),
              ('campaign_assurance_progress_events', 'status'),
              ('campaign_assurance_progress_events', 'entity_id'),
              ('campaign_assurance_progress_events', 'artifact_id'),
              ('campaign_assurance_progress_events', 'configuration_id'),
              ('campaign_assurance_progress_events', 'receipt_hash'),
              ('campaign_assurance_progress_events', 'occurred_at')
        )
        SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
         WHERE namespace.nspname = 'public'
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND has_column_privilege(
               'postwave_campaign_assurance_ops_definer',
               relation.oid,
               attribute.attnum,
               'SELECT'
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM expected AS expected_column
                WHERE expected_column.table_name = relation.relname
                  AND expected_column.column_name = attribute.attname
           )
    ) OR EXISTS (
        SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege(
               'postwave_campaign_assurance_ops_definer', relation.oid,
               'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
    ) THEN
        RAISE EXCEPTION 'Campaign Assurance ops definer has an unexpected relation privilege';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
               'campaign_assurance_runs',
               'campaign_assurance_commands',
               'campaign_assurance_run_targets',
               'campaign_assurance_extractions',
               'campaign_assurance_model_invocation_reservations',
               'campaign_assurance_model_invocation_results',
               'seed_message_observations',
               'campaign_assurance_progress_events'
           )
           AND has_table_privilege(
               'postwave_ops', relation.oid,
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
    ) OR EXISTS (
        SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
               'campaign_assurance_runs',
               'campaign_assurance_commands',
               'campaign_assurance_run_targets',
               'campaign_assurance_extractions',
               'campaign_assurance_model_invocation_reservations',
               'campaign_assurance_model_invocation_results',
               'seed_message_observations',
               'campaign_assurance_progress_events'
           )
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND has_column_privilege(
               'postwave_ops', relation.oid, attribute.attnum,
               'SELECT,INSERT,UPDATE,REFERENCES'
           )
    ) THEN
        RAISE EXCEPTION 'postwave_ops must not have Campaign Assurance base-table access';
    END IF;
END;
$$;

COMMIT;
