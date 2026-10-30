-- 1931_campaign_assurance_modeled_cache_and_cost_budget.sql
--
-- Exact-hash modeled-result reuse and a hard aggregate provider-cost ceiling.
-- Reservations are durable before invocation and are never released because a
-- timeout or lost lease can still have been billed. Cache reuse is restricted
-- to an immutable invoked origin in a still-complete exact-provenance run with
-- a live retained raw output. Reused receipts remain append-only evidence.
--
-- rollback-strategy: no-op. Removing cost reservations or cache lineage would
-- destroy billing/audit evidence and permit old workers to overspend.

BEGIN;

ALTER TABLE campaign_assurance_runs
    ADD COLUMN max_modeled_cost_microunits bigint NOT NULL DEFAULT 0
        CHECK (max_modeled_cost_microunits >= 0);

ALTER TABLE campaign_assurance_extractions
    ADD COLUMN model_cache_key text CHECK (
        model_cache_key IS NULL OR model_cache_key ~ '^[0-9a-f]{64}$'
    ),
    ADD COLUMN model_input_manifest_hash text CHECK (
        model_input_manifest_hash IS NULL OR model_input_manifest_hash ~ '^[0-9a-f]{64}$'
    ),
    ADD COLUMN model_invocation_id text CHECK (
        model_invocation_id IS NULL OR model_invocation_id ~ '^[0-9a-f]{64}$'
    ),
    ADD COLUMN execution_kind text CHECK (
        execution_kind IS NULL OR execution_kind IN ('invoked', 'cache_reuse')
    ),
    ADD COLUMN reused_from_extraction_id uuid,
    ADD COLUMN reused_from_receipt_hash text CHECK (
        reused_from_receipt_hash IS NULL OR reused_from_receipt_hash ~ '^[0-9a-f]{64}$'
    ),
    ADD COLUMN reused_original_cost_microunits bigint NOT NULL DEFAULT 0
        CHECK (reused_original_cost_microunits >= 0);

CREATE UNIQUE INDEX campaign_assurance_extractions_tenant_id_id_uidx
    ON campaign_assurance_extractions (tenant_id, id);

ALTER TABLE campaign_assurance_extractions
    ADD CONSTRAINT campaign_assurance_extractions_reused_source_fk
        FOREIGN KEY (tenant_id, reused_from_extraction_id)
        REFERENCES campaign_assurance_extractions (tenant_id, id)
        ON DELETE CASCADE,
    ADD CONSTRAINT campaign_assurance_extractions_modeled_execution_shape_check CHECK (
        (execution_kind IS NULL
            AND model_cache_key IS NULL
            AND model_input_manifest_hash IS NULL
            AND model_invocation_id IS NULL
            AND reused_from_extraction_id IS NULL
            AND reused_from_receipt_hash IS NULL
            AND reused_original_cost_microunits = 0)
        OR
        (source_class = 'modeled'
            AND execution_kind = 'invoked'
            AND model_cache_key IS NOT NULL
            AND model_input_manifest_hash IS NOT NULL
            AND model_invocation_id IS NOT NULL
            AND reused_from_extraction_id IS NULL
            AND reused_from_receipt_hash IS NULL
            AND reused_original_cost_microunits = 0)
        OR
        (source_class = 'modeled'
            AND status = 'complete'
            AND execution_kind = 'cache_reuse'
            AND model_cache_key IS NOT NULL
            AND model_input_manifest_hash IS NOT NULL
            AND model_invocation_id IS NOT NULL
            AND reused_from_extraction_id IS NOT NULL
            AND reused_from_receipt_hash IS NOT NULL
            AND input_tokens = 0 AND output_tokens = 0
            AND cost_microunits = 0 AND latency_ms = 0
            AND raw_output_object_ref IS NOT NULL
            AND raw_output_hash IS NOT NULL
            AND raw_output_expires_at IS NOT NULL)
    );

CREATE TABLE campaign_assurance_model_invocation_reservations (
    tenant_id                  uuid NOT NULL,
    campaign_id                uuid NOT NULL,
    run_id                     uuid NOT NULL,
    attempt_count              integer NOT NULL CHECK (attempt_count >= 1),
    claim_token                uuid NOT NULL,
    invocation_id              text NOT NULL CHECK (invocation_id ~ '^[0-9a-f]{64}$'),
    model_cache_key            text NOT NULL CHECK (model_cache_key ~ '^[0-9a-f]{64}$'),
    model_input_manifest_hash  text NOT NULL CHECK (
                                      model_input_manifest_hash ~ '^[0-9a-f]{64}$'
                                  ),
    artifact_id                uuid NOT NULL,
    configuration_id           text NOT NULL CHECK (
                                      configuration_id ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                                  ),
    configuration_hash         text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
    outbound_mime_hash         text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    reserved_microunits        bigint NOT NULL CHECK (
                                      reserved_microunits BETWEEN 1 AND 1000000000000000
                                  ),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, invocation_id),
    UNIQUE (tenant_id, run_id, attempt_count, artifact_id, configuration_id),
    CONSTRAINT campaign_assurance_model_reservations_run_fk
        FOREIGN KEY (tenant_id, campaign_id, run_id)
        REFERENCES campaign_assurance_runs (tenant_id, campaign_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_model_reservations_target_fk
        FOREIGN KEY (tenant_id, run_id, artifact_id, configuration_id)
        REFERENCES campaign_assurance_run_targets (
            tenant_id, run_id, artifact_id, configuration_id
        )
        ON DELETE CASCADE
);

CREATE TABLE campaign_assurance_model_invocation_results (
    tenant_id          uuid NOT NULL,
    campaign_id        uuid NOT NULL,
    run_id             uuid NOT NULL,
    attempt_count      integer NOT NULL CHECK (attempt_count >= 1),
    claim_token        uuid NOT NULL,
    invocation_id      text NOT NULL CHECK (invocation_id ~ '^[0-9a-f]{64}$'),
    status             text NOT NULL CHECK (status IN (
                           'complete', 'error', 'unavailable', 'charge_unknown'
                       )),
    input_tokens       bigint NOT NULL DEFAULT 0 CHECK (
                           input_tokens BETWEEN 0 AND 1000000000000
                       ),
    output_tokens      bigint NOT NULL DEFAULT 0 CHECK (
                           output_tokens BETWEEN 0 AND 1000000000000
                       ),
    cost_microunits    bigint NOT NULL DEFAULT 0 CHECK (
                           cost_microunits BETWEEN 0 AND 1000000000000000
                       ),
    latency_ms         bigint NOT NULL DEFAULT 0 CHECK (
                           latency_ms BETWEEN 0 AND 1000000000000
                       ),
    reason_code        text CHECK (
                           reason_code IS NULL OR reason_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
                       ),
    receipt_hash       text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, invocation_id),
    CONSTRAINT campaign_assurance_model_results_reservation_fk
        FOREIGN KEY (tenant_id, run_id, invocation_id)
        REFERENCES campaign_assurance_model_invocation_reservations (
            tenant_id, run_id, invocation_id
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_model_results_status_shape_check CHECK (
        (status = 'complete' AND reason_code IS NULL)
        OR
        (status IN ('error', 'unavailable') AND reason_code IS NOT NULL)
        OR
        (status = 'charge_unknown' AND reason_code IS NOT NULL
            AND input_tokens = 0 AND output_tokens = 0 AND cost_microunits = 0)
    )
);

CREATE INDEX campaign_assurance_model_reservations_run_cost_idx
    ON campaign_assurance_model_invocation_reservations (tenant_id, run_id, reserved_microunits);

CREATE OR REPLACE FUNCTION campaign_assurance_model_invocation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    parent_state text;
    parent_attempt integer;
    parent_claim uuid;
    parent_lease timestamptz;
    parent_budget bigint;
    already_reserved bigint;
    target_reservation bigint;
    reservation campaign_assurance_model_invocation_reservations%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.campaign_assurance_runs
         WHERE tenant_id = OLD.tenant_id AND id = OLD.run_id
    ) THEN
        RETURN OLD;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'campaign assurance model invocation evidence is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'campaign assurance model invocation requires worker scope'
            USING ERRCODE = '42501';
    END IF;

    IF TG_TABLE_NAME = 'campaign_assurance_model_invocation_reservations' THEN
        SELECT state, attempt_count, claim_token, lease_expires_at,
               max_modeled_cost_microunits
          INTO parent_state, parent_attempt, parent_claim, parent_lease,
               parent_budget
          FROM public.campaign_assurance_runs
         WHERE tenant_id = NEW.tenant_id
           AND campaign_id = NEW.campaign_id
           AND id = NEW.run_id
         FOR UPDATE;
        IF NOT FOUND OR parent_state <> 'running' OR
           parent_attempt <> NEW.attempt_count OR parent_claim <> NEW.claim_token OR
           parent_lease <= statement_timestamp() THEN
            RAISE EXCEPTION 'campaign assurance reservation is outside the active attempt'
                USING ERRCODE = '55000';
        END IF;
        SELECT COALESCE(
                   NULLIF(configuration.configuration->>'maximum_cost_microunits', '')::bigint,
                   0
               )
          INTO target_reservation
          FROM public.campaign_assurance_run_targets AS target
          JOIN public.campaign_assurance_run_configurations AS configuration
            ON configuration.tenant_id = target.tenant_id
           AND configuration.run_id = target.run_id
           AND configuration.configuration_id = target.configuration_id
         WHERE target.tenant_id = NEW.tenant_id AND target.run_id = NEW.run_id
           AND target.artifact_id = NEW.artifact_id
           AND target.configuration_id = NEW.configuration_id
           AND target.source_class = 'modeled'
           AND target.configuration_hash = NEW.configuration_hash
           AND target.outbound_mime_hash = NEW.outbound_mime_hash;
        IF NOT FOUND OR target_reservation <> NEW.reserved_microunits THEN
            RAISE EXCEPTION 'campaign assurance reservation target is not exact modeled evidence'
                USING ERRCODE = '55000';
        END IF;
        SELECT COALESCE(sum(reserved_microunits), 0)::bigint
          INTO already_reserved
          FROM public.campaign_assurance_model_invocation_reservations
         WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id;
        IF NEW.reserved_microunits > parent_budget OR
           already_reserved > parent_budget - NEW.reserved_microunits THEN
            RAISE EXCEPTION 'campaign assurance modeled run cost budget exhausted'
                USING ERRCODE = 'P0001', CONSTRAINT = 'campaign_assurance_modeled_cost_budget';
        END IF;
        RETURN NEW;
    END IF;

    SELECT * INTO reservation
      FROM public.campaign_assurance_model_invocation_reservations
     WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id
       AND invocation_id = NEW.invocation_id
     FOR SHARE;
    SELECT state, attempt_count, claim_token, lease_expires_at
      INTO parent_state, parent_attempt, parent_claim, parent_lease
      FROM public.campaign_assurance_runs
     WHERE tenant_id = NEW.tenant_id
       AND campaign_id = NEW.campaign_id
       AND id = NEW.run_id
     FOR SHARE;
    IF reservation.invocation_id IS NULL OR NOT FOUND OR parent_state <> 'running' OR
       parent_attempt <> NEW.attempt_count OR parent_claim <> NEW.claim_token OR
       parent_lease <= statement_timestamp() OR
       reservation.campaign_id <> NEW.campaign_id OR
       reservation.attempt_count <> NEW.attempt_count OR
       reservation.claim_token <> NEW.claim_token OR
       NEW.cost_microunits > reservation.reserved_microunits THEN
        RAISE EXCEPTION 'campaign assurance invocation result exceeds or escapes its reservation'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_model_reservations_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_model_invocation_reservations
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_model_invocation_guard();

CREATE TRIGGER campaign_assurance_model_results_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_model_invocation_results
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_model_invocation_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_modeled_extraction_provenance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    current_run campaign_assurance_runs%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' OR NEW.execution_kind IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO current_run
      FROM public.campaign_assurance_runs
     WHERE tenant_id = NEW.tenant_id AND campaign_id = NEW.campaign_id
       AND id = NEW.run_id
     FOR SHARE;

    IF NEW.execution_kind = 'invoked' THEN
        IF NOT EXISTS (
            SELECT 1
              FROM public.campaign_assurance_model_invocation_reservations AS reservation
              JOIN public.campaign_assurance_model_invocation_results AS result
                ON result.tenant_id = reservation.tenant_id
               AND result.run_id = reservation.run_id
               AND result.invocation_id = reservation.invocation_id
             WHERE reservation.tenant_id = NEW.tenant_id
               AND reservation.run_id = NEW.run_id
               AND reservation.attempt_count = NEW.attempt_count
               AND reservation.claim_token = NEW.claim_token
               AND reservation.invocation_id = NEW.model_invocation_id
               AND reservation.model_cache_key = NEW.model_cache_key
               AND reservation.model_input_manifest_hash = NEW.model_input_manifest_hash
               AND reservation.artifact_id = NEW.artifact_id
               AND reservation.configuration_id = NEW.configuration_id
               AND reservation.configuration_hash = NEW.configuration_hash
               AND reservation.outbound_mime_hash = NEW.outbound_mime_hash
               AND result.input_tokens = NEW.input_tokens
               AND result.output_tokens = NEW.output_tokens
               AND result.cost_microunits = NEW.cost_microunits
               AND (
                   (NEW.status = 'complete' AND result.status = 'complete') OR
                   (NEW.status = 'error' AND result.status = 'error') OR
                   (NEW.status = 'unavailable' AND result.status = 'unavailable')
               )
        ) THEN
            RAISE EXCEPTION 'invoked modeled extraction lacks an exact settled reservation'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.campaign_assurance_extractions AS source
          JOIN public.campaign_assurance_runs AS source_run
            ON source_run.tenant_id = source.tenant_id
           AND source_run.campaign_id = source.campaign_id
           AND source_run.id = source.run_id
           AND source_run.attempt_count = source.attempt_count
          JOIN public.campaign_assurance_model_invocation_results AS source_result
            ON source_result.tenant_id = source.tenant_id
           AND source_result.run_id = source.run_id
           AND source_result.invocation_id = source.model_invocation_id
         WHERE source.tenant_id = NEW.tenant_id
           AND source.id = NEW.reused_from_extraction_id
           AND source.receipt_hash = NEW.reused_from_receipt_hash
           AND source.source_class = 'modeled'
           AND source.status = 'complete'
           AND source.execution_kind = 'invoked'
           AND source.reused_from_extraction_id IS NULL
           AND source.artifact_id = NEW.artifact_id
           AND source.configuration_id = NEW.configuration_id
           AND source.configuration_hash = NEW.configuration_hash
           AND source.outbound_mime_hash = NEW.outbound_mime_hash
           AND source.model_cache_key = NEW.model_cache_key
           AND source.model_input_manifest_hash = NEW.model_input_manifest_hash
           AND source.raw_output_object_ref = NEW.raw_output_object_ref
           AND source.raw_output_hash = NEW.raw_output_hash
           AND source.raw_output_expires_at = NEW.raw_output_expires_at
           AND source.raw_output_expires_at > statement_timestamp()
           AND source.model_provider = NEW.model_provider
           AND source.model_id = NEW.model_id
           AND source.model_version = NEW.model_version
           AND source.prompt_version = NEW.prompt_version
           AND source.prompt_hash = NEW.prompt_hash
           AND source.seed_value IS NOT DISTINCT FROM NEW.seed_value
           AND source.temperature IS NOT DISTINCT FROM NEW.temperature
           AND source.cost_microunits = NEW.reused_original_cost_microunits
           AND source_result.status = 'complete'
           AND source_result.input_tokens = source.input_tokens
           AND source_result.output_tokens = source.output_tokens
           AND source_result.cost_microunits = source.cost_microunits
           AND source_run.state = 'complete'
           AND source_run.id <> current_run.id
           AND source_run.campaign_id = current_run.campaign_id
           AND source_run.content_revision_id = current_run.content_revision_id
           AND source_run.send_plan_id = current_run.send_plan_id
           AND source_run.source_hash = current_run.source_hash
           AND source_run.plan_hash = current_run.plan_hash
           AND source_run.artifact_set_hash = current_run.artifact_set_hash
           AND source_run.coverage_manifest_hash = current_run.coverage_manifest_hash
           AND source_run.configuration_manifest_hash = current_run.configuration_manifest_hash
           AND source_run.target_manifest_hash = current_run.target_manifest_hash
           AND source_run.renderer_version = current_run.renderer_version
           AND source_run.compiler_version = current_run.compiler_version
           AND source_run.fixture_set_version = current_run.fixture_set_version
           AND source_run.plan_policy_version = current_run.plan_policy_version
           AND source_run.analyzer_suite_version = current_run.analyzer_suite_version
           AND source_run.model_suite_version = current_run.model_suite_version
           AND source_run.prompt_suite_version = current_run.prompt_suite_version
           AND source_run.prompt_suite_hash = current_run.prompt_suite_hash
           AND source_run.normalization_version = current_run.normalization_version
           AND source_run.scoring_version = current_run.scoring_version
           AND source_run.gate_policy_version = current_run.gate_policy_version
           AND source_run.methodology_version = current_run.methodology_version
    ) THEN
        RAISE EXCEPTION 'modeled cache reuse source is stale, partial, expired, or inexact'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_extractions_modeled_provenance_guard
    BEFORE INSERT ON campaign_assurance_extractions
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_modeled_extraction_provenance_guard();

-- This trigger sorts after the v1921 lifecycle trigger. The earlier trigger
-- still proves target/finding aggregates; this one replaces modeled usage with
-- the all-attempt settlement ledger so retries cannot disappear from cost.
CREATE OR REPLACE FUNCTION campaign_assurance_runs_zz_modeled_cost_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    modeled_input bigint;
    modeled_output bigint;
    modeled_cost bigint;
    modeled_latency bigint;
    other_input bigint;
    other_output bigint;
    other_cost bigint;
    other_latency bigint;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.state = 'running' AND
       NEW.state IN ('complete', 'incomplete', 'failed') THEN
        SELECT COALESCE(sum(input_tokens), 0)::bigint,
               COALESCE(sum(output_tokens), 0)::bigint,
               COALESCE(sum(cost_microunits), 0)::bigint,
               COALESCE(sum(latency_ms), 0)::bigint
          INTO modeled_input, modeled_output, modeled_cost, modeled_latency
          FROM public.campaign_assurance_model_invocation_results
         WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id;
        SELECT COALESCE(sum(input_tokens), 0)::bigint,
               COALESCE(sum(output_tokens), 0)::bigint,
               COALESCE(sum(cost_microunits), 0)::bigint,
               COALESCE(sum(latency_ms), 0)::bigint
          INTO other_input, other_output, other_cost, other_latency
          FROM public.campaign_assurance_extractions
         WHERE tenant_id = OLD.tenant_id AND run_id = OLD.id
           AND attempt_count = OLD.attempt_count
           AND source_class <> 'modeled';
        NEW.input_tokens := modeled_input + other_input;
        NEW.output_tokens := modeled_output + other_output;
        NEW.cost_microunits := modeled_cost + other_cost;
        NEW.latency_ms := modeled_latency + other_latency;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_runs_zz_modeled_cost_aggregate
    BEFORE UPDATE ON campaign_assurance_runs
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_runs_zz_modeled_cost_aggregate();

ALTER TABLE campaign_assurance_model_invocation_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_model_invocation_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_model_reservations_scope_boundary
    ON campaign_assurance_model_invocation_reservations
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_model_reservations_tenant_select
    ON campaign_assurance_model_invocation_reservations
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_model_reservations_worker_select
    ON campaign_assurance_model_invocation_reservations
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_model_reservations_worker_insert
    ON campaign_assurance_model_invocation_reservations
    FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_assurance_model_invocation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_model_invocation_results FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_assurance_model_results_scope_boundary
    ON campaign_assurance_model_invocation_results
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_model_results_tenant_select
    ON campaign_assurance_model_invocation_results
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_model_results_worker_select
    ON campaign_assurance_model_invocation_results
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_model_results_worker_insert
    ON campaign_assurance_model_invocation_results
    FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT ON campaign_assurance_model_invocation_reservations TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_model_invocation_results TO postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_model_invocation_reservations FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_model_invocation_results FROM postwave_app;

COMMENT ON COLUMN campaign_assurance_runs.max_modeled_cost_microunits IS
    'Frozen all-attempt maximum modeled provider reservation; never a mutable spending target.';
COMMENT ON TABLE campaign_assurance_model_invocation_reservations IS
    'Immutable pre-provider worst-case reservations; ambiguous calls are never refunded.';
COMMENT ON TABLE campaign_assurance_model_invocation_results IS
    'Immutable known metering or explicit unknown-charge settlement for one reserved invocation.';
COMMENT ON COLUMN campaign_assurance_extractions.model_cache_key IS
    'Tenant-bound exact semantic model input identity; operational run/attempt identifiers are excluded.';
COMMENT ON COLUMN campaign_assurance_extractions.reused_from_extraction_id IS
    'Direct invoked-origin lineage only; cache-reuse chains are forbidden.';

COMMIT;
