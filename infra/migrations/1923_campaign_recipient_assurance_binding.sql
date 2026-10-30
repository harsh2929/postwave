-- 1923_campaign_recipient_assurance_binding.sql
--
-- Carries the exact queue-time Campaign Assurance authorization into every
-- recipient work item. Shadow-rollout rows may remain unbound; once the
-- application gate is enabled it inserts the complete immutable identity.
-- Later delivery workers must use these columns instead of looking up "latest"
-- evidence after the queue decision.
--
-- rollback-strategy: no-op. A recipient/delivery audit may already depend on
-- these identities and removing them would make historical authorization
-- unverifiable.

BEGIN;

ALTER TABLE campaign_recipients
    ADD COLUMN IF NOT EXISTS content_revision_id uuid,
    ADD COLUMN IF NOT EXISTS send_plan_id uuid,
    ADD COLUMN IF NOT EXISTS assurance_run_id uuid,
    ADD COLUMN IF NOT EXISTS assurance_attempt_count integer,
    ADD COLUMN IF NOT EXISTS assurance_artifact_set_hash text,
    ADD COLUMN IF NOT EXISTS assurance_source_hash text,
    ADD COLUMN IF NOT EXISTS assurance_plan_hash text,
    ADD COLUMN IF NOT EXISTS assurance_gate_decision text,
    ADD COLUMN IF NOT EXISTS assurance_override_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN IF NOT EXISTS assurance_bound_at timestamptz;

ALTER TABLE campaign_recipients
    ADD CONSTRAINT campaign_recipients_assurance_shape_check CHECK (
        (
            content_revision_id IS NULL
            AND send_plan_id IS NULL
            AND assurance_run_id IS NULL
            AND assurance_attempt_count IS NULL
            AND assurance_artifact_set_hash IS NULL
            AND assurance_source_hash IS NULL
            AND assurance_plan_hash IS NULL
            AND assurance_gate_decision IS NULL
            AND cardinality(assurance_override_ids) = 0
            AND assurance_bound_at IS NULL
        )
        OR
        (
            content_revision_id IS NOT NULL
            AND send_plan_id IS NOT NULL
            AND assurance_run_id IS NOT NULL
            AND assurance_attempt_count >= 1
            AND assurance_artifact_set_hash ~ '^[0-9a-f]{64}$'
            AND assurance_source_hash ~ '^[0-9a-f]{64}$'
            AND assurance_plan_hash ~ '^[0-9a-f]{64}$'
            AND assurance_gate_decision IN ('pass', 'warn', 'overridden')
            AND assurance_bound_at IS NOT NULL
            AND (
                (assurance_gate_decision IN ('pass', 'warn')
                    AND cardinality(assurance_override_ids) = 0)
                OR
                (assurance_gate_decision = 'overridden'
                    AND cardinality(assurance_override_ids) > 0)
            )
        )
    ) NOT VALID;

ALTER TABLE campaign_recipients
    ADD CONSTRAINT campaign_recipients_assurance_revision_fk
        FOREIGN KEY (
            tenant_id, campaign_id, content_revision_id, assurance_source_hash
        )
        REFERENCES campaign_content_revisions (
            tenant_id, campaign_id, id, source_hash
        )
        NOT VALID,
    ADD CONSTRAINT campaign_recipients_assurance_plan_fk
        FOREIGN KEY (
            tenant_id, campaign_id, content_revision_id, send_plan_id,
            assurance_plan_hash
        )
        REFERENCES campaign_send_plans (
            tenant_id, campaign_id, content_revision_id, id, plan_hash
        )
        NOT VALID,
    ADD CONSTRAINT campaign_recipients_assurance_run_fk
        FOREIGN KEY (
            tenant_id, campaign_id, assurance_run_id, send_plan_id,
            assurance_attempt_count, assurance_artifact_set_hash,
            assurance_source_hash, assurance_plan_hash
        )
        REFERENCES campaign_assurance_runs (
            tenant_id, campaign_id, id, send_plan_id, attempt_count,
            artifact_set_hash, source_hash, plan_hash
        )
        NOT VALID;

CREATE INDEX IF NOT EXISTS campaign_recipients_assurance_pending_idx
    ON campaign_recipients (
        tenant_id, campaign_id, assurance_run_id, send_plan_id, id
    )
    WHERE status IN ('pending', 'sending') AND assurance_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION campaign_recipients_assurance_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF ROW(
        NEW.content_revision_id, NEW.send_plan_id, NEW.assurance_run_id,
        NEW.assurance_attempt_count, NEW.assurance_artifact_set_hash,
        NEW.assurance_source_hash, NEW.assurance_plan_hash,
        NEW.assurance_gate_decision, NEW.assurance_override_ids,
        NEW.assurance_bound_at
    ) IS DISTINCT FROM ROW(
        OLD.content_revision_id, OLD.send_plan_id, OLD.assurance_run_id,
        OLD.assurance_attempt_count, OLD.assurance_artifact_set_hash,
        OLD.assurance_source_hash, OLD.assurance_plan_hash,
        OLD.assurance_gate_decision, OLD.assurance_override_ids,
        OLD.assurance_bound_at
    ) THEN
        RAISE EXCEPTION 'campaign recipient assurance binding is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS campaign_recipients_assurance_binding_guard
    ON campaign_recipients;
CREATE TRIGGER campaign_recipients_assurance_binding_guard
    BEFORE UPDATE ON campaign_recipients
    FOR EACH ROW EXECUTE FUNCTION campaign_recipients_assurance_binding_guard();

COMMENT ON COLUMN campaign_recipients.assurance_run_id IS
    'Exact queue-time Campaign Assurance run; NULL only for pre-rollout/shadow rows.';
COMMENT ON COLUMN campaign_recipients.assurance_override_ids IS
    'Complete sorted finding-scoped override set used by the queue authorization.';

COMMIT;
