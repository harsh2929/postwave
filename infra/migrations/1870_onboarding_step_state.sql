-- 1870_onboarding_step_state.sql
--
-- Make an onboarding DECISION durable, and shared across a person's devices.
--
-- `GET /api/v1/onboarding-progress` derives every step's done-ness server-side
-- in one query — that part is already correct and already shared. What is not
-- shared is anything a human decided: "dismissed", "snoozed", "not applicable
-- to us", "someone else is doing this". Those live in per-device keys
-- (`postwave_onboarding_checklist_dismissed`, `postwave_tour_dashboard_dismissed_at`
-- and friends in localStorage / AsyncStorage).
--
-- So a user dismisses the checklist on desktop, opens the web app, and it is
-- back. Dismisses it there, picks up their phone, and it is back again. The
-- product asks the same question on every device until they answer it on every
-- device — and the answer was never a device's to hold.
--
-- SCOPED TO (tenant, user, step). Per-user rather than per-tenant because these
-- are personal decisions: one admin dismissing a checklist must not hide it from
-- a colleague who has not seen it. Per-tenant would make the first person to
-- click "dismiss" decide for everyone, which is a different and worse bug than
-- the one being fixed.
--
-- DERIVED DONE-NESS IS NOT STORED HERE. Whether a step is complete stays a query
-- over real data, because a stored copy would drift the moment someone deleted
-- the thing that completed it. This table holds only what cannot be derived: a
-- choice a person made.

BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_step_state (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL,
    step_key    text        NOT NULL,
    state       text        NOT NULL,
    -- Free text for `skipped`: "we use Salesforce for this". Optional, and the
    -- reason a skip is worth distinguishing from a dismissal — one is "not now",
    -- the other is "not us", and only the second should stay gone.
    reason      text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, step_key),
    CONSTRAINT onboarding_step_state_state_check CHECK (
        state = ANY (ARRAY['dismissed', 'snoozed', 'skipped', 'inapplicable', 'delegated'])
    )
);

COMMENT ON TABLE onboarding_step_state IS
    'Per-user onboarding DECISIONS. Done-ness stays derived by '
    'GET /api/v1/onboarding-progress; this holds only what a query cannot '
    'recover: that a person chose to dismiss, snooze, skip or delegate a step. '
    'Before it, those choices lived in per-device localStorage/AsyncStorage, so '
    'the product re-asked on every device until answered on every device.';

ALTER TABLE onboarding_step_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_step_state FORCE ROW LEVEL SECURITY;

-- The repo-wide idiom: a raw cast crashes when the GUC is unset, so NULLIF the
-- empty string first.
CREATE POLICY onboarding_step_state_tenant_isolation ON onboarding_step_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_step_state TO postwave_app;

COMMIT;
