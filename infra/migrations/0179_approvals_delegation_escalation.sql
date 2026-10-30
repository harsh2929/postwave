-- 0179_approvals_delegation_escalation.sql
--
-- Extends the approvals system with two workflow primitives that
-- turn it from a gate into a real product:
--
--   1. DELEGATION — Alice tells the system "Bob can decide my
--      approvals while I'm on PTO this week." For the date range,
--      any approval whose requested_by_user_id == alice is also
--      decideable by bob without triggering the self-approval
--      refusal we added in migration 0173.
--
--   2. ESCALATION — when no admin decides a pending approval within
--      escalate_after_hours, the system emits an "approval.escalated"
--      event + (optionally) re-notifies a fallback role (owner).
--      Closes the "agent waits forever on a Friday-afternoon send"
--      class of incidents.
--
-- Both tables are tenant-scoped (RLS) and back-compat: pre-existing
-- approvals see no behaviour change until an operator configures
-- a delegation row or sets escalate_after_hours.

BEGIN;

CREATE TABLE IF NOT EXISTS approval_delegations (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The user being covered. While the delegation is active,
    -- approvals whose requested_by_user_id == from_user_id are
    -- decideable by to_user_id WITHOUT triggering ErrSelfApproval.
    from_user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The delegate. Must have owner/admin role at decide time
    -- (RequireScope on the decide route enforces; we don't snapshot
    -- the role here).
    to_user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Half-open window [starts_at, ends_at). NULL ends_at = open-ended
    -- (rare; operators usually pick a return-from-PTO date).
    starts_at          timestamptz NOT NULL DEFAULT now(),
    ends_at            timestamptz,
    reason             text        NOT NULL DEFAULT '',
    created_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    revoked_at         timestamptz,
    CONSTRAINT approval_delegations_no_self_delegate
        CHECK (from_user_id <> to_user_id)
);

CREATE INDEX IF NOT EXISTS approval_delegations_active_idx
    ON approval_delegations (tenant_id, from_user_id, to_user_id)
    WHERE revoked_at IS NULL;

ALTER TABLE approval_delegations ENABLE ROW LEVEL SECURITY;

CREATE POLICY approval_delegations_tenant_isolation
    ON approval_delegations
    FOR ALL
    USING (tenant_id::text = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_delegations TO postwave_app;

-- Per-tenant escalation policy. Single row per tenant; operators set
-- escalate_after_hours = NULL to disable (the default).
CREATE TABLE IF NOT EXISTS approval_escalation_policies (
    tenant_id             uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    escalate_after_hours  int,
    -- When true, the escalation sweeper writes "approval.escalated"
    -- audit log entries + emits the event on the bus. Notification
    -- delivery (email, Slack) hangs off the bus subscriber.
    notify_owners         boolean NOT NULL DEFAULT true,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE approval_escalation_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY approval_escalation_policies_tenant_isolation
    ON approval_escalation_policies
    FOR ALL
    USING (tenant_id::text = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_escalation_policies TO postwave_app;

-- Per-approval escalation marker. Set by the sweeper when it fires
-- an escalation event for a row, so repeat ticks don't re-emit.
ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

CREATE INDEX IF NOT EXISTS approvals_pending_escalation_idx
    ON approvals (tenant_id, requested_at)
    WHERE status = 'pending' AND escalated_at IS NULL;

COMMIT;
