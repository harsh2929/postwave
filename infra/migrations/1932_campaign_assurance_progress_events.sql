-- 1932_campaign_assurance_progress_events.sql
--
-- Transactional, append-only progress evidence for Campaign Assurance. Every
-- event is derived by database triggers from the durable lifecycle/evidence
-- ledgers; application callers cannot manufacture progress or insert directly.
-- Per-run event numbers are serialized by locking the parent run, which makes
-- replay and support cursors deterministic even under concurrent workers.
--
-- rollback-strategy: no-op. Progress receipts are audit evidence and may be
-- referenced by support exports after a newer binary has been rolled back.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE campaign_assurance_progress_events (
    tenant_id        uuid NOT NULL,
    campaign_id      uuid NOT NULL,
    run_id           uuid NOT NULL,
    event_no         bigint NOT NULL CHECK (event_no > 0),
    event_id         uuid NOT NULL DEFAULT gen_random_uuid(),
    attempt_count    integer NOT NULL CHECK (attempt_count >= 0),
    event_type       text NOT NULL CHECK (event_type IN (
                         'run_created', 'snapshot_frozen', 'run_claimed',
                         'lease_renewed', 'run_requeued', 'run_completed',
                         'run_incomplete', 'run_failed', 'run_cancelled',
                         'run_stale', 'extraction_recorded', 'finding_recorded',
                         'override_recorded', 'model_invocation_reserved',
                         'model_invocation_settled'
                     )),
    stage            text NOT NULL CHECK (stage IN (
                         'lifecycle', 'deterministic', 'modeled',
                         'controlled_observation', 'governance'
                     )),
    status           text NOT NULL CHECK (
                         length(status) BETWEEN 1 AND 64
                         AND status ~ '^[a-z0-9][a-z0-9_.-]*$'
                     ),
    entity_id        uuid,
    artifact_id      uuid,
    configuration_id text CHECK (
                         configuration_id IS NULL OR
                         configuration_id ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                     ),
    receipt_hash     text CHECK (
                         receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$'
                     ),
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                         jsonb_typeof(metadata) = 'object'
                         AND octet_length(metadata::text) <= 8192
                     ),
    occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (tenant_id, run_id, event_no),
    UNIQUE (tenant_id, event_id),
    CONSTRAINT campaign_assurance_progress_events_run_fk
        FOREIGN KEY (tenant_id, campaign_id, run_id)
        REFERENCES campaign_assurance_runs (tenant_id, campaign_id, id)
        ON DELETE CASCADE
);

CREATE INDEX campaign_assurance_progress_events_campaign_cursor_idx
    ON campaign_assurance_progress_events (
        tenant_id, campaign_id, occurred_at DESC, event_id DESC
    );
CREATE INDEX campaign_assurance_progress_events_status_idx
    ON campaign_assurance_progress_events (
        event_type, status, occurred_at DESC
    );

CREATE OR REPLACE FUNCTION campaign_assurance_append_progress_event(
    target_tenant_id uuid,
    target_campaign_id uuid,
    target_run_id uuid,
    target_attempt_count integer,
    target_event_type text,
    target_stage text,
    target_status text,
    target_entity_id uuid DEFAULT NULL,
    target_artifact_id uuid DEFAULT NULL,
    target_configuration_id text DEFAULT NULL,
    target_receipt_hash text DEFAULT NULL,
    target_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    next_event_no bigint;
BEGIN
    -- The parent-row lock is the per-run sequence allocator. Child evidence
    -- writers already hold or reference this row, so the lock also gives the
    -- progress event the same commit/rollback boundary as its source record.
    PERFORM 1
      FROM public.campaign_assurance_runs
     WHERE tenant_id = target_tenant_id
       AND campaign_id = target_campaign_id
       AND id = target_run_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'campaign assurance progress parent run does not exist'
            USING ERRCODE = '23503';
    END IF;

    SELECT COALESCE(max(event_no), 0) + 1
      INTO next_event_no
      FROM public.campaign_assurance_progress_events
     WHERE tenant_id = target_tenant_id AND run_id = target_run_id;

    INSERT INTO public.campaign_assurance_progress_events (
        tenant_id, campaign_id, run_id, event_no, attempt_count,
        event_type, stage, status, entity_id, artifact_id,
        configuration_id, receipt_hash, metadata
    ) VALUES (
        target_tenant_id, target_campaign_id, target_run_id, next_event_no,
        target_attempt_count, target_event_type, target_stage, target_status,
        target_entity_id, target_artifact_id, target_configuration_id,
        target_receipt_hash, COALESCE(target_metadata, '{}'::jsonb)
    );
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_assurance_append_progress_event(
    uuid, uuid, uuid, integer, text, text, text, uuid, uuid, text, text, jsonb
) FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION campaign_assurance_run_progress_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
            'run_created', 'lifecycle', NEW.state,
            NEW.id, NULL, NULL, NULL,
            jsonb_build_object('profile', NEW.profile, 'trigger_kind', NEW.trigger_kind)
        );
        RETURN NEW;
    END IF;

    IF OLD.snapshot_frozen_at IS NULL AND NEW.snapshot_frozen_at IS NOT NULL THEN
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
            'snapshot_frozen', 'lifecycle', NEW.state,
            NEW.id, NULL, NULL, NULL,
            jsonb_build_object(
                'required_scenario_count', NEW.required_scenario_count,
                'required_configuration_count', NEW.required_configuration_count,
                'required_extraction_count', NEW.required_extraction_count
            )
        );
    END IF;

    IF OLD.state IS DISTINCT FROM NEW.state THEN
        IF NEW.state = 'running' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_claimed', 'lifecycle', NEW.state, NEW.id
            );
        ELSIF OLD.state = 'running' AND NEW.state = 'queued' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_requeued', 'lifecycle', NEW.state, NEW.id, NULL, NULL,
                NULL, jsonb_build_object('error_code', NEW.error_code)
            );
        ELSIF NEW.state = 'complete' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_completed', 'lifecycle', NEW.state, NEW.id, NULL, NULL,
                NULL, jsonb_build_object('gate_decision', NEW.gate_decision)
            );
        ELSIF NEW.state = 'incomplete' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_incomplete', 'lifecycle', NEW.state, NEW.id, NULL, NULL,
                NULL, jsonb_build_object('gate_decision', NEW.gate_decision)
            );
        ELSIF NEW.state = 'failed' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_failed', 'lifecycle', NEW.state, NEW.id, NULL, NULL,
                NULL, jsonb_build_object('error_code', NEW.error_code)
            );
        ELSIF NEW.state = 'cancelled' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_cancelled', 'lifecycle', NEW.state, NEW.id
            );
        ELSIF NEW.state = 'stale' THEN
            PERFORM public.campaign_assurance_append_progress_event(
                NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
                'run_stale', 'lifecycle', NEW.state, NEW.id
            );
        END IF;
    ELSIF NEW.state = 'running' AND OLD.heartbeat_at IS DISTINCT FROM NEW.heartbeat_at THEN
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.id, NEW.attempt_count,
            'lease_renewed', 'lifecycle', NEW.state, NEW.id
        );
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_runs_progress
    AFTER INSERT OR UPDATE ON campaign_assurance_runs
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_run_progress_trigger();

CREATE OR REPLACE FUNCTION campaign_assurance_evidence_progress_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    event_stage text;
BEGIN
    IF TG_TABLE_NAME = 'campaign_assurance_extractions' THEN
        event_stage := CASE NEW.source_class
            WHEN 'deterministic' THEN 'deterministic'
            WHEN 'modeled' THEN 'modeled'
            ELSE 'controlled_observation'
        END;
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.run_id, NEW.attempt_count,
            'extraction_recorded', event_stage, NEW.status, NEW.id,
            NEW.artifact_id, NEW.configuration_id, NEW.receipt_hash,
            jsonb_build_object('source_class', NEW.source_class)
        );
    ELSIF TG_TABLE_NAME = 'campaign_assurance_findings' THEN
        event_stage := CASE NEW.source_class
            WHEN 'deterministic' THEN 'deterministic'
            WHEN 'modeled' THEN 'modeled'
            ELSE 'controlled_observation'
        END;
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.run_id, NEW.attempt_count,
            'finding_recorded', event_stage, NEW.severity, NEW.id,
            NEW.artifact_id, NEW.configuration_id, NEW.receipt_hash,
            jsonb_build_object(
                'source_class', NEW.source_class,
                'code', NEW.code,
                'blocking', NEW.blocking
            )
        );
    ELSE
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.run_id, NEW.attempt_count,
            'override_recorded', 'governance', NEW.decision, NEW.id,
            NULL, NULL, NULL,
            jsonb_build_object(
                'finding_id', NEW.finding_id,
                'request_hash', NEW.request_hash
            )
        );
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_extractions_progress
    AFTER INSERT ON campaign_assurance_extractions
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_evidence_progress_trigger();
CREATE TRIGGER campaign_assurance_findings_progress
    AFTER INSERT ON campaign_assurance_findings
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_evidence_progress_trigger();
CREATE TRIGGER campaign_assurance_overrides_progress
    AFTER INSERT ON campaign_assurance_overrides
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_evidence_progress_trigger();

CREATE OR REPLACE FUNCTION campaign_assurance_model_progress_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_TABLE_NAME = 'campaign_assurance_model_invocation_reservations' THEN
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.run_id, NEW.attempt_count,
            'model_invocation_reserved', 'modeled', 'reserved', NULL,
            NEW.artifact_id, NEW.configuration_id, NULL,
            jsonb_build_object(
                'invocation_id', NEW.invocation_id,
                'reserved_microunits', NEW.reserved_microunits
            )
        );
    ELSE
        PERFORM public.campaign_assurance_append_progress_event(
            NEW.tenant_id, NEW.campaign_id, NEW.run_id, NEW.attempt_count,
            'model_invocation_settled', 'modeled', NEW.status, NULL,
            NULL, NULL, NEW.receipt_hash,
            jsonb_build_object(
                'invocation_id', NEW.invocation_id,
                'cost_microunits', NEW.cost_microunits
            )
        );
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_model_reservations_progress
    AFTER INSERT ON campaign_assurance_model_invocation_reservations
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_model_progress_trigger();
CREATE TRIGGER campaign_assurance_model_results_progress
    AFTER INSERT ON campaign_assurance_model_invocation_results
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_model_progress_trigger();

CREATE OR REPLACE FUNCTION campaign_assurance_progress_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1
          FROM public.campaign_assurance_runs
         WHERE tenant_id = OLD.tenant_id AND id = OLD.run_id
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'campaign_assurance_progress_events is append-only'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_progress_events_append_only
    BEFORE UPDATE OR DELETE ON campaign_assurance_progress_events
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_progress_events_append_only();

ALTER TABLE campaign_assurance_progress_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_progress_events FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_assurance_progress_events_scope_boundary
    ON campaign_assurance_progress_events
    AS RESTRICTIVE FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_progress_events_tenant_select
    ON campaign_assurance_progress_events
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- A SECURITY DEFINER trigger can still be subject to FORCE RLS when the
-- migration owner is not BYPASSRLS. This policy authorizes only a row already
-- bound to the transaction-local tenant. Direct application INSERT remains
-- impossible because table INSERT is revoked below and the helper is not
-- executable by the application role.
CREATE POLICY campaign_assurance_progress_events_trigger_insert
    ON campaign_assurance_progress_events
    FOR INSERT TO PUBLIC
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON campaign_assurance_progress_events TO postwave_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON campaign_assurance_progress_events FROM postwave_app;

COMMENT ON TABLE campaign_assurance_progress_events IS
    'Trigger-derived append-only Campaign Assurance progress receipts; contains no body, model output, recipient, seed credential, or lease secret.';
COMMENT ON COLUMN campaign_assurance_progress_events.event_no IS
    'Gap-free commit-ordered cursor within one run, serialized by the parent run row.';
COMMENT ON COLUMN campaign_assurance_progress_events.metadata IS
    'Bounded server-authored operational metadata; never accepts caller or email content.';

COMMIT;
