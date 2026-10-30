-- 1918_ai_regression_durable_lifecycle.sql
--
-- Durable lifecycle substrate for the AI regression runner.  A run freezes
-- both the tenant settings and every live golden example in the same
-- transaction that creates the pending run.  Workers claim with a fenced
-- token + monotonically increasing attempt, heartbeat a bounded lease, and
-- finish through compare-and-swap transitions.  Expired claims are repaired
-- back to pending without losing the immutable input snapshot.
--
-- rollback-strategy: no-op.  The new columns/table/indexes are additive and
-- old application versions ignore them; dropping the snapshot would destroy
-- historical replay inputs.

BEGIN;

-- Manual and approval-driven captures can be retried after an ambiguous
-- network outcome without double-weighting the corpus. NULL remains valid for
-- historical rows; every new public capture supplies a tenant-scoped UUID.
ALTER TABLE ai_golden_examples
    ADD COLUMN IF NOT EXISTS capture_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ai_golden_examples_capture_request_uidx
    ON ai_golden_examples (tenant_id, capture_request_id)
    WHERE capture_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ai_golden_examples_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id OR
		NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
		NEW.surface_kind IS DISTINCT FROM OLD.surface_kind OR
		NEW.brief IS DISTINCT FROM OLD.brief OR
		NEW.approved_output IS DISTINCT FROM OLD.approved_output OR
		NEW.model_id IS DISTINCT FROM OLD.model_id OR
		NEW.voice_profile_version IS DISTINCT FROM OLD.voice_profile_version OR
		NEW.approval_id IS DISTINCT FROM OLD.approval_id OR
		NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id OR
		NEW.capture_request_id IS DISTINCT FROM OLD.capture_request_id OR
		NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'ai golden example evidence is immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
		RAISE EXCEPTION 'archived ai golden evidence cannot be restored or re-timestamped'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ai_golden_examples_evidence_immutable
	ON ai_golden_examples;
CREATE TRIGGER ai_golden_examples_evidence_immutable
	BEFORE UPDATE ON ai_golden_examples
	FOR EACH ROW EXECUTE FUNCTION ai_golden_examples_evidence_guard();

REVOKE UPDATE, DELETE ON ai_golden_examples FROM postwave_app;
GRANT UPDATE (archived_at) ON ai_golden_examples TO postwave_app;

ALTER TABLE ai_regression_runs
	ADD COLUMN IF NOT EXISTS runtime_provider text NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS scored_examples integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS error_examples integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS hard_gate_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS min_examples_for_gate integer NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS snapshot_frozen_at timestamptz,
    ADD COLUMN IF NOT EXISTS claim_token uuid,
    ADD COLUMN IF NOT EXISTS lease_owner text,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
    ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
	ADD COLUMN IF NOT EXISTS retry_not_before timestamptz,
    ADD COLUMN IF NOT EXISTS stale_at timestamptz,
    ADD COLUMN IF NOT EXISTS error_code text,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE ai_regression_runs
   SET hard_gate_enabled = (hard_gate_threshold IS NOT NULL),
       min_examples_for_gate = 5,
	   runtime_provider = COALESCE(NULLIF(runtime_provider, ''), 'unknown'),
	   max_attempts = COALESCE(NULLIF(max_attempts, 0), 3),
	   attempt_count = CASE
		   WHEN status IN ('running', 'completed', 'failed') AND attempt_count = 0 THEN 1
		   ELSE attempt_count
	   END,
       updated_at = COALESCE(updated_at, created_at)
 WHERE snapshot_frozen_at IS NULL;

-- A pre-lifecycle pending row has no immutable run-example manifest: the
-- snapshot table did not exist when it was queued, and reconstructing from the
-- current mutable golden set would fabricate historical evidence. Retire it
-- explicitly so it cannot strand the tenant behind the one-active invariant.
UPDATE ai_regression_runs
   SET status = 'failed',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       error_code = 'unsnapshotted_legacy_run',
       error_message = 'a legacy pending regression run without an immutable input snapshot was retired during lifecycle hardening',
       completed_at = now(),
       updated_at = now()
 WHERE status = 'pending'
   AND snapshot_frozen_at IS NULL;

-- Older executors persisted raw provider text without a public-safe code.
-- Redact it before terminal immutability is installed, and retain only a
-- fixed operator-safe receipt.
UPDATE ai_regression_runs
   SET error_code = 'legacy_failure_details_withheld',
       error_message = 'legacy regression failure details were withheld'
 WHERE error_message IS NOT NULL
   AND error_code IS NULL;

ALTER TABLE ai_regression_runs
	DROP CONSTRAINT IF EXISTS ai_regression_runs_receipt_counts_check,
	ADD CONSTRAINT ai_regression_runs_receipt_counts_check CHECK (
		scored_examples >= 0
		AND error_examples >= 0
		AND passed_examples >= 0
		AND passed_examples <= scored_examples
		AND scored_examples + error_examples <= total_examples
		AND (status <> 'completed' OR scored_examples + error_examples = total_examples)
	) NOT VALID,
	DROP CONSTRAINT IF EXISTS ai_regression_runs_score_bounds_check,
	ADD CONSTRAINT ai_regression_runs_score_bounds_check CHECK (
		(fidelity_score_mean IS NULL OR fidelity_score_mean BETWEEN 0 AND 100)
		AND (fidelity_score_p25 IS NULL OR fidelity_score_p25 BETWEEN 0 AND 100)
		AND warn_threshold BETWEEN 0 AND 100
		AND (hard_gate_threshold IS NULL OR hard_gate_threshold BETWEEN 0 AND 100)
	) NOT VALID,
	DROP CONSTRAINT IF EXISTS ai_regression_runs_runtime_identity_check,
	ADD CONSTRAINT ai_regression_runs_runtime_identity_check CHECK (
		length(model_id) BETWEEN 1 AND 200
		AND length(model_version_tag) BETWEEN 1 AND 160
		AND length(prompt_version_tag) BETWEEN 1 AND 160
	) NOT VALID,
    DROP CONSTRAINT IF EXISTS ai_regression_runs_min_examples_check,
    ADD CONSTRAINT ai_regression_runs_min_examples_check
        CHECK (min_examples_for_gate >= 1),
	DROP CONSTRAINT IF EXISTS ai_regression_runs_attempt_count_check,
    ADD CONSTRAINT ai_regression_runs_attempt_count_check
        CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
	DROP CONSTRAINT IF EXISTS ai_regression_runs_max_attempts_check,
	ADD CONSTRAINT ai_regression_runs_max_attempts_check
		CHECK (max_attempts BETWEEN 1 AND 20),
	DROP CONSTRAINT IF EXISTS ai_regression_runs_runtime_provider_check,
	ADD CONSTRAINT ai_regression_runs_runtime_provider_check
		CHECK (length(runtime_provider) BETWEEN 1 AND 100),
    DROP CONSTRAINT IF EXISTS ai_regression_runs_error_code_check,
    ADD CONSTRAINT ai_regression_runs_error_code_check
        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
    DROP CONSTRAINT IF EXISTS ai_regression_runs_error_message_bound_check,
    ADD CONSTRAINT ai_regression_runs_error_message_bound_check
        CHECK (error_message IS NULL OR length(error_message) <= 1000) NOT VALID,
    DROP CONSTRAINT IF EXISTS ai_regression_runs_claim_shape_check,
    ADD CONSTRAINT ai_regression_runs_claim_shape_check CHECK (
        (status = 'pending'
            AND claim_token IS NULL
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND heartbeat_at IS NULL
            AND completed_at IS NULL)
        OR
        (status = 'running'
            AND claim_token IS NOT NULL
            AND lease_owner IS NOT NULL
            AND length(lease_owner) BETWEEN 1 AND 200
            AND lease_expires_at IS NOT NULL
            AND heartbeat_at IS NOT NULL
			AND retry_not_before IS NULL
            AND started_at IS NOT NULL
            AND completed_at IS NULL
            AND attempt_count >= 1)
        OR
        (status IN ('completed', 'failed')
            AND claim_token IS NULL
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND heartbeat_at IS NULL
			AND retry_not_before IS NULL
            AND completed_at IS NOT NULL)
    ) NOT VALID;

-- Legacy running rows pre-date leases and cannot be safely fenced. Retire
-- them instead of leaving an unclaimable active row that blocks its tenant.
UPDATE ai_regression_runs
   SET status = 'failed',
       error_code = 'unfenced_legacy_run',
       error_message = 'an unfenced legacy regression run was retired during lifecycle hardening',
       completed_at = now(),
       updated_at = now()
 WHERE status = 'running'
   AND claim_token IS NULL;

-- Collapse any legacy race-created active duplicates before installing the
-- actual one-active-run invariant.  Keep the oldest run (the one a worker
-- would already have observed) and fail later duplicates with a safe public
-- reason.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY tenant_id
               ORDER BY created_at, id
           ) AS active_rank
      FROM ai_regression_runs
     WHERE status IN ('pending', 'running')
)
UPDATE ai_regression_runs AS runs
   SET status = 'failed',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       error_code = 'duplicate_active_run',
       error_message = 'a duplicate active regression run was retired during lifecycle hardening',
       completed_at = now(),
       updated_at = now()
  FROM ranked
 WHERE runs.id = ranked.id
   AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS ai_regression_runs_one_active_tenant_idx
    ON ai_regression_runs (tenant_id)
    WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS ai_regression_runs_worker_claim_idx
    ON ai_regression_runs (retry_not_before, created_at, id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ai_regression_runs_stale_lease_idx
    ON ai_regression_runs (lease_expires_at, heartbeat_at, id)
    WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS ai_regression_runs_tenant_id_id_uidx
    ON ai_regression_runs (tenant_id, id);

CREATE TABLE IF NOT EXISTS ai_regression_run_examples (
    tenant_id             uuid NOT NULL,
    run_id                uuid NOT NULL,
    example_id            uuid NOT NULL,
    ordinal               integer NOT NULL CHECK (ordinal >= 1),
    surface_kind          text NOT NULL CHECK (surface_kind IN (
        'campaign_draft', 'subject_line', 'sequence_draft',
        'campaign_summary', 'reply_intent'
    )),
    brief                 text NOT NULL CHECK (length(brief) BETWEEN 1 AND 8000),
    approved_output       text NOT NULL CHECK (length(approved_output) BETWEEN 1 AND 32000),
    source_model_id       text NOT NULL,
    voice_profile_version text,
    approval_id           uuid,
    agent_run_id          uuid,
    source_created_at     timestamptz NOT NULL,
    snapshotted_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, run_id, example_id),
    UNIQUE (tenant_id, run_id, ordinal),
    CONSTRAINT ai_regression_run_examples_run_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES ai_regression_runs (tenant_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_regression_run_examples_run_surface_idx
    ON ai_regression_run_examples (tenant_id, run_id, surface_kind, ordinal);

CREATE OR REPLACE FUNCTION ai_regression_run_examples_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    parent_status text;
    frozen_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT status, snapshot_frozen_at
          INTO parent_status, frozen_at
          FROM public.ai_regression_runs
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.run_id
         FOR KEY SHARE;
        IF NOT FOUND OR parent_status <> 'pending' OR frozen_at IS NOT NULL THEN
            RAISE EXCEPTION 'ai regression example snapshot is frozen'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1
          FROM public.ai_regression_runs
         WHERE tenant_id = OLD.tenant_id
           AND id = OLD.run_id
    ) THEN
        -- Parent/tenant cascade cleanup remains possible.
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'ai regression example snapshots are immutable'
        USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS ai_regression_run_examples_immutable
    ON ai_regression_run_examples;
CREATE TRIGGER ai_regression_run_examples_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON ai_regression_run_examples
    FOR EACH ROW EXECUTE FUNCTION ai_regression_run_examples_guard();

CREATE OR REPLACE FUNCTION ai_regression_runs_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF OLD.status IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal ai regression runs are immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.snapshot_frozen_at IS NOT NULL AND (
        NEW.snapshot_frozen_at IS DISTINCT FROM OLD.snapshot_frozen_at OR
        NEW.total_examples IS DISTINCT FROM OLD.total_examples OR
		NEW.runtime_provider IS DISTINCT FROM OLD.runtime_provider OR
        NEW.model_id IS DISTINCT FROM OLD.model_id OR
        NEW.model_version_tag IS DISTINCT FROM OLD.model_version_tag OR
        NEW.prompt_version_tag IS DISTINCT FROM OLD.prompt_version_tag OR
        NEW.warn_threshold IS DISTINCT FROM OLD.warn_threshold OR
        NEW.hard_gate_enabled IS DISTINCT FROM OLD.hard_gate_enabled OR
        NEW.hard_gate_threshold IS DISTINCT FROM OLD.hard_gate_threshold OR
        NEW.min_examples_for_gate IS DISTINCT FROM OLD.min_examples_for_gate
		OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    ) THEN
        RAISE EXCEPTION 'ai regression run snapshot is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status = 'running') OR
        (OLD.status = 'running' AND NEW.status IN ('pending', 'completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid ai regression run transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    IF OLD.status = 'running' AND NEW.status = 'pending'
		AND NEW.stale_at IS NULL AND NEW.retry_not_before IS NULL THEN
		RAISE EXCEPTION 'requeued ai regression run must record stale_at or retry_not_before'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ai_regression_runs_lifecycle_guard
    ON ai_regression_runs;
CREATE TRIGGER ai_regression_runs_lifecycle_guard
    BEFORE UPDATE ON ai_regression_runs
    FOR EACH ROW EXECUTE FUNCTION ai_regression_runs_lifecycle_guard();

DROP TRIGGER IF EXISTS ai_regression_runs_set_updated_at
    ON ai_regression_runs;
CREATE TRIGGER ai_regression_runs_set_updated_at
    BEFORE UPDATE ON ai_regression_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Historical results pre-date the lifecycle snapshot and can contain repeated
-- receipts for the same example. Preserve every one as forensic evidence
-- instead of deleting rows or choosing a fabricated canonical winner. New
-- lifecycle-managed receipts are explicitly classified and receive the
-- durable first-write-wins invariant below. Results remain attempt-scoped so
-- a retry can never combine nondeterministic outputs from worker attempts.
ALTER TABLE ai_regression_results
	ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
	ADD COLUMN IF NOT EXISTS error_code text,
	ADD COLUMN IF NOT EXISTS durable_receipt boolean;

UPDATE ai_regression_results
   SET durable_receipt = false
 WHERE durable_receipt IS NULL;

ALTER TABLE ai_regression_results
	ALTER COLUMN durable_receipt SET DEFAULT true,
	ALTER COLUMN durable_receipt SET NOT NULL;

UPDATE ai_regression_results
   SET error_code = 'legacy_failure_details_withheld',
       error_message = 'legacy regression failure details were withheld'
 WHERE error_message IS NOT NULL
   AND error_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_regression_results_tenant_run_attempt_example_uidx
    ON ai_regression_results (tenant_id, run_id, attempt_count, example_id)
    WHERE example_id IS NOT NULL AND durable_receipt;

ALTER TABLE ai_regression_results
	DROP CONSTRAINT IF EXISTS ai_regression_results_example_id_fkey,
	DROP CONSTRAINT IF EXISTS ai_regression_results_score_check,
	ADD CONSTRAINT ai_regression_results_score_check
		CHECK (fidelity_score IS NULL OR fidelity_score BETWEEN 0 AND 100) NOT VALID,
	DROP CONSTRAINT IF EXISTS ai_regression_results_attempt_count_check,
	ADD CONSTRAINT ai_regression_results_attempt_count_check
		CHECK (attempt_count >= 1),
	DROP CONSTRAINT IF EXISTS ai_regression_results_error_code_check,
	ADD CONSTRAINT ai_regression_results_error_code_check
		CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$') NOT VALID,
	DROP CONSTRAINT IF EXISTS ai_regression_results_error_message_bound_check,
	ADD CONSTRAINT ai_regression_results_error_message_bound_check
		CHECK (error_message IS NULL OR length(error_message) <= 1000) NOT VALID,
	DROP CONSTRAINT IF EXISTS ai_regression_results_receipt_shape_check,
	ADD CONSTRAINT ai_regression_results_receipt_shape_check CHECK (
		NOT durable_receipt OR (
			(severity = 'error'
				AND fidelity_score IS NULL
				AND error_code IS NOT NULL
				AND breakdown IS NULL)
			OR
			(severity IN ('ok', 'warn', 'critical')
				AND fidelity_score IS NOT NULL
				AND error_code IS NULL
				AND error_message IS NULL
				AND jsonb_typeof(breakdown) = 'object'
				AND breakdown ?& ARRAY[
					'embedding_similarity', 'stylistic_distance',
					'vocabulary_overlap', 'structural_match', 'combined'
				]
				AND breakdown - ARRAY[
					'embedding_similarity', 'stylistic_distance',
					'vocabulary_overlap', 'structural_match', 'combined'
				] = '{}'::jsonb
				AND jsonb_typeof(breakdown -> 'embedding_similarity') = 'number'
				AND jsonb_typeof(breakdown -> 'stylistic_distance') = 'number'
				AND jsonb_typeof(breakdown -> 'vocabulary_overlap') = 'number'
				AND jsonb_typeof(breakdown -> 'structural_match') = 'number'
				AND jsonb_typeof(breakdown -> 'combined') = 'number'
				AND (breakdown ->> 'embedding_similarity')::float8 BETWEEN 0 AND 1
				AND (breakdown ->> 'stylistic_distance')::float8 BETWEEN 0 AND 1
				AND (breakdown ->> 'vocabulary_overlap')::float8 BETWEEN 0 AND 1
				AND (breakdown ->> 'structural_match')::float8 BETWEEN 0 AND 1
				AND (breakdown ->> 'combined')::float8 BETWEEN 0 AND 100
				AND abs((breakdown ->> 'combined')::float8 - fidelity_score) <= 0.000001)
		) IS TRUE
	) NOT VALID,
    DROP CONSTRAINT IF EXISTS ai_regression_results_tenant_run_fk,
    ADD CONSTRAINT ai_regression_results_tenant_run_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES ai_regression_runs (tenant_id, id)
        ON DELETE CASCADE NOT VALID,
    DROP CONSTRAINT IF EXISTS ai_regression_results_snapshot_example_fk,
    ADD CONSTRAINT ai_regression_results_snapshot_example_fk
        FOREIGN KEY (tenant_id, run_id, example_id)
        REFERENCES ai_regression_run_examples (tenant_id, run_id, example_id)
        ON DELETE CASCADE NOT VALID;

CREATE OR REPLACE FUNCTION ai_regression_results_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
	parent_status text;
	parent_attempt integer;
	snapshot_surface text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.durable_receipt IS NOT TRUE THEN
			RAISE EXCEPTION 'new ai regression results must be durable lifecycle receipts'
				USING ERRCODE = '55000';
		END IF;
		SELECT runs.status, runs.attempt_count, examples.surface_kind
		  INTO parent_status, parent_attempt, snapshot_surface
		  FROM public.ai_regression_runs AS runs
		  JOIN public.ai_regression_run_examples AS examples
		    ON examples.tenant_id = runs.tenant_id
		   AND examples.run_id = runs.id
		   AND examples.example_id = NEW.example_id
		 WHERE runs.tenant_id = NEW.tenant_id
		   AND runs.id = NEW.run_id
		 FOR KEY SHARE OF runs;
		IF NOT FOUND OR parent_status <> 'running' OR
			parent_attempt <> NEW.attempt_count OR snapshot_surface <> NEW.surface_kind THEN
			RAISE EXCEPTION 'ai regression result does not belong to the active snapshot attempt'
				USING ERRCODE = '55000';
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
		-- First-write-wins conflict handling performs a literal no-op update so
		-- PostgreSQL can return the already persisted receipt.
		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' AND NOT EXISTS (
		SELECT 1
		  FROM public.ai_regression_runs
		 WHERE tenant_id = OLD.tenant_id
		   AND id = OLD.run_id
	) THEN
		RETURN OLD;
	END IF;

	RAISE EXCEPTION 'ai regression results are immutable'
		USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS ai_regression_results_immutable
	ON ai_regression_results;
CREATE TRIGGER ai_regression_results_immutable
	BEFORE INSERT OR UPDATE OR DELETE ON ai_regression_results
	FOR EACH ROW EXECUTE FUNCTION ai_regression_results_guard();

GRANT SELECT, INSERT ON ai_regression_run_examples TO postwave_app;
GRANT UPDATE ON ai_regression_results TO postwave_app;

ALTER TABLE ai_regression_run_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_regression_run_examples FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ai_regression_run_examples;
CREATE POLICY tenant_isolation ON ai_regression_run_examples
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS ai_regression_run_examples_worker_select
    ON ai_regression_run_examples;
CREATE POLICY ai_regression_run_examples_worker_select
    ON ai_regression_run_examples
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

DROP POLICY IF EXISTS ai_regression_runs_worker_update
    ON ai_regression_runs;
CREATE POLICY ai_regression_runs_worker_update ON ai_regression_runs
    AS PERMISSIVE FOR UPDATE
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
