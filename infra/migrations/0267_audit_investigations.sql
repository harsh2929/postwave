-- 0267_audit_investigations.sql
--
-- ai-investigation-agent (audit-2026 AI/Anomaly, P1).
--
-- Persists the output of the autonomous investigation agent:
-- numbered hypotheses, the audit_log row IDs each hypothesis cites
-- as evidence, MITRE ATT&CK techniques, and the proposed remediation
-- actions that ALWAYS require a human approver before they run.
--
-- Hard rule (enforced in the Go validator on insert): every entry in
-- findings MUST cite at least one audit_log.id in its evidence_ids
-- array. The agent is allowed to be wrong about causation but it is
-- NOT allowed to invent facts without a cited source row.
--
-- Lifecycle: draft → (approved|rejected) → executed.
--
--   draft    — the agent loop completed and findings are ready for
--              human review.
--   approved — a human approver signed off on findings + actions.
--              executed_at is set when the action executor finishes
--              the proposed remediations.
--   rejected — a human approver dismissed the investigation;
--              rejection_reason carries the audit trail rationale.
--   executed — all approved actions have been applied (or recorded
--              as already-applied / idempotent).

BEGIN;

CREATE TABLE IF NOT EXISTS audit_investigations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    -- The audit_log row that triggered the investigation. Either an
    -- auto-trigger from a high-risk anomaly score, or a manual
    -- "Investigate" click from the AuditEventSlideover.
    seed_audit_id      bigint NOT NULL,

    -- Numbered hypotheses, JSON shape:
    --   [{ num: 1, hypothesis: "...", mitre_techniques: ["T1078"],
    --      confidence: 0.85, evidence_audit_ids: [123,124] }]
    -- The Go writer enforces non-empty evidence_audit_ids on insert.
    findings           jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Flat union of every audit_log.id referenced anywhere in
    -- findings, persisted as a top-level column so the read path can
    -- range-scan / join without parsing JSON.
    evidence_audit_ids bigint[] NOT NULL DEFAULT '{}'::bigint[],

    -- Proposed remediation actions. Each action carries
    -- requires_human_approval=true; the action executor will refuse
    -- to apply any action that does not carry that flag. JSON shape:
    --   [{ id: "uuid", action: "disable_user", target_id: "...",
    --      rationale: "...", severity: "high",
    --      requires_human_approval: true }]
    proposed_actions   jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- MITRE ATT&CK technique IDs aggregated across all findings.
    -- Denormalised so the list endpoint can filter on a single technique
    -- without unnesting the findings JSON.
    mitre_techniques   text[] NOT NULL DEFAULT '{}'::text[],

    -- [0..1] aggregate confidence across hypotheses. Drives the
    -- "confidence meter" component on the AuditInvestigation page.
    confidence         double precision NOT NULL DEFAULT 0,

    status             text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'approved', 'rejected', 'executed')),

    approved_at        timestamptz,
    approved_by        uuid,
    rejection_reason   text,

    completed_at       timestamptz,
    executed_at        timestamptz,
    executed_by        uuid,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    -- One investigation per seed event per tenant. Concurrent triggers
    -- collapse to the first inserter; the handler silently returns the
    -- existing investigation id.
    UNIQUE (tenant_id, seed_audit_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_investigations_tenant_status
    ON audit_investigations (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_investigations_seed_audit
    ON audit_investigations (seed_audit_id);

CREATE INDEX IF NOT EXISTS idx_audit_investigations_evidence
    ON audit_investigations USING GIN (evidence_audit_ids);

CREATE INDEX IF NOT EXISTS idx_audit_investigations_mitre
    ON audit_investigations USING GIN (mitre_techniques);

GRANT SELECT, INSERT, UPDATE ON audit_investigations TO postwave_app;

ALTER TABLE audit_investigations ENABLE ROW LEVEL SECURITY;

-- Standard tenant-GUC isolation. The NULLIF guards against the
-- GUC being unset (raw cast crashes on '').
CREATE POLICY tenant_visible ON audit_investigations
    AS PERMISSIVE FOR ALL TO postwave_app
    USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Background worker policy. The investigation executor runs without a
-- tenant cookie but with app.audit_investigation_worker='true' set on
-- the connection, which lets it update status → executed and stamp
-- executed_at after a successful action apply.
CREATE POLICY audit_investigations_worker_update ON audit_investigations
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING  (current_setting('app.audit_investigation_worker', true) = 'true')
    WITH CHECK (current_setting('app.audit_investigation_worker', true) = 'true');

COMMIT;
