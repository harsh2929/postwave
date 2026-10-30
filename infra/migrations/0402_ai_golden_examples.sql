-- 0402_ai_golden_examples.sql
--
-- AI-Output Regression Harness (platform-2026 "golden-set firewall"):
-- per-tenant (brief -> approved-output) pairs that constitute the golden
-- set used to detect silent brand-voice regression across model/prompt
-- upgrades. When a human approves an AI-generated output (agent-routine
-- approval, or an explicit "save as reference" action), the pair is
-- snapshotted here so a later replay through a new model can be scored
-- against the tenant's voice profile.
--
-- Capture sources (surface_kind):
--   campaign_draft   -> aicompose broadcast approval
--   subject_line     -> subject lab approval
--   sequence_draft   -> voice sequence approval
--   campaign_summary -> campaign summary regeneration approval
--   reply_intent     -> reply-intent classification approval
--
-- voice_profile_version snapshots the profile identity at capture time so
-- replay scoring can detect (and honestly flag) when a score shift was
-- caused by a profile rebuild rather than a model change.
--
-- Soft-delete (archived_at) rather than hard-delete: a retired example
-- stays in historical run results but is excluded from future replays.
--
-- rollback-strategy: no-op - additive table; prior releases never read it,
-- so leaving it in place during a rollback is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_golden_examples (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    surface_kind    text NOT NULL
        CHECK (surface_kind IN (
            'campaign_draft', 'subject_line', 'sequence_draft',
            'campaign_summary', 'reply_intent'
        )),
    -- The prompt/brief sent to the LLM. Bounded to the voice service cap.
    brief           text NOT NULL CHECK (length(brief) BETWEEN 1 AND 8000),
    -- The human-approved output (HTML stripped to plain text on capture).
    approved_output text NOT NULL CHECK (length(approved_output) BETWEEN 1 AND 32000),
    -- Model identifier that produced this output (segments results by model).
    model_id        text NOT NULL DEFAULT 'unknown',
    -- Voice profile identity at capture time (staleness guard). Free-text
    -- so the capture path can stamp whatever the profile store exposes.
    voice_profile_version text,
    -- Approval back-reference for audit trail. Nullable: manually-added
    -- examples have no approval row.
    approval_id     uuid REFERENCES approvals(id) ON DELETE SET NULL,
    -- Agent-routine run back-reference (no FK: runs live in a separate
    -- partition; the column is a soft pointer for the trust drilldown).
    agent_run_id    uuid,
    archived_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_golden_examples_tenant_surface_idx
    ON ai_golden_examples (tenant_id, surface_kind, created_at DESC)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS ai_golden_examples_approval_idx
    ON ai_golden_examples (approval_id)
    WHERE approval_id IS NOT NULL;

CREATE TRIGGER ai_golden_examples_set_updated_at
    BEFORE UPDATE ON ai_golden_examples
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_golden_examples TO postwave_app;

ALTER TABLE ai_golden_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_golden_examples FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_golden_examples
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant SELECT for the deployment-gate replay runner (operator CLI
-- under db.WithWorkerScope), mirroring agent_routines_worker_select (0386).
-- The runner re-binds app.tenant_id per tenant before scoring, so result
-- writes still pass tenant_isolation.
CREATE POLICY ai_golden_examples_worker_select ON ai_golden_examples
    AS PERMISSIVE FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
