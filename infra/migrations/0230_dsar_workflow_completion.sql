-- 0230_dsar_workflow_completion.sql
--
-- Closes the four "remaining_manual_steps" on the DSAR workflow:
--   1. Identity verification — challenge token issuance/confirmation
--      so a request can be lifted from "queued" -> "verifying" ->
--      "in_progress" before any fulfillment work begins.
--   2. Legal hold review — operator surface to set/clear hold +
--      reason, with audit-tracked reviewer and the "blocked_legal_hold"
--      status transition.
--   3. Subprocessor deletion confirmation — durable per-(request,
--      subprocessor) ack rows so we can prove downstream erasure
--      against Stripe/AWS/OpenAI/Sentry/PostHog before fulfilling.
--   4. Counsel-approved denial/appeal handling — denied_reason
--      column and a typed appeals table linking a parent rejected
--      request to its appeal child row.
--
-- All tenant-scoped RLS uses the NULLIF(current_setting('app.tenant_id',
-- true), '')::uuid idiom so an unset GUC does not crash with
-- "invalid input syntax for type uuid".

BEGIN;

-- ---------------------------------------------------------------------------
-- privacy_requests: new columns
-- ---------------------------------------------------------------------------
ALTER TABLE privacy_requests
    ADD COLUMN IF NOT EXISTS verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS verified_method text
        CHECK (verified_method IS NULL OR verified_method IN ('email_token', 'session', 'admin_override')),
    ADD COLUMN IF NOT EXISTS denied_reason text,
    ADD COLUMN IF NOT EXISTS hold_reason text,
    ADD COLUMN IF NOT EXISTS hold_reviewer_user_id uuid;

-- Worker bypass policy: the OverdueWorker and DeletionFulfillmentWorker
-- run cross-tenant under app.outbox_worker='true' (no app.tenant_id
-- GUC set). Without this companion policy the gauge worker silently
-- reads zero rows and the deletion worker can never promote a row.
DROP POLICY IF EXISTS outbox_worker_access ON privacy_requests;
CREATE POLICY outbox_worker_access ON privacy_requests
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- audit_log gets the matching bypass so the deletion worker can
-- write a "privacy.deletion_fulfilled" row tagged with the affected
-- tenant_id without first opening a tenant-scoped tx.
DROP POLICY IF EXISTS outbox_worker_access ON audit_log;
CREATE POLICY outbox_worker_access ON audit_log
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------------
-- privacy_request_verifications — challenge tokens for DSAR identity
-- verification. Tokens are stored as a hash (no plaintext at rest).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_request_verifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_id      text NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
    token_hash      text NOT NULL,
    sent_to         citext,
    method          text NOT NULL DEFAULT 'email_token'
                    CHECK (method IN ('email_token', 'session', 'admin_override')),
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    verified_at     timestamptz,
    consumed        boolean NOT NULL DEFAULT false,
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS privacy_request_verifications_tenant_request_idx
    ON privacy_request_verifications (tenant_id, request_id, issued_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_request_verifications TO postwave_app;

ALTER TABLE privacy_request_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_request_verifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON privacy_request_verifications;
CREATE POLICY tenant_isolation ON privacy_request_verifications
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON privacy_request_verifications;
CREATE POLICY tenant_visible ON privacy_request_verifications
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- privacy_request_subprocessor_acks — per (request_id, subprocessor)
-- record of downstream deletion acknowledgement. Used as a gate by
-- the deletion fulfillment worker before flipping a row to fulfilled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_request_subprocessor_acks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_id        text NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
    subprocessor      text NOT NULL,
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'acknowledged', 'not_applicable', 'failed')),
    acknowledged_at   timestamptz,
    acknowledged_by   uuid,
    evidence_url      text,
    notes             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, request_id, subprocessor)
);

CREATE INDEX IF NOT EXISTS privacy_request_subprocessor_acks_request_idx
    ON privacy_request_subprocessor_acks (tenant_id, request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_request_subprocessor_acks TO postwave_app;

ALTER TABLE privacy_request_subprocessor_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_request_subprocessor_acks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON privacy_request_subprocessor_acks;
CREATE POLICY tenant_isolation ON privacy_request_subprocessor_acks
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON privacy_request_subprocessor_acks;
CREATE POLICY tenant_visible ON privacy_request_subprocessor_acks
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Worker bypass: deletion fulfillment worker reads ack rows
-- cross-tenant inside the same scan that promotes privacy_requests.
DROP POLICY IF EXISTS outbox_worker_access ON privacy_request_subprocessor_acks;
CREATE POLICY outbox_worker_access ON privacy_request_subprocessor_acks
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------------
-- privacy_request_appeals — link table from a denied (status='rejected')
-- parent privacy_requests row to its appeal child row. Appeal child
-- row is itself a privacy_requests row with request_type='appeal'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_request_appeals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    parent_request_id  text NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
    appeal_request_id  text NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
    reason             text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz,
    resolution         text CHECK (resolution IS NULL OR resolution IN ('upheld', 'overturned', 'withdrawn')),
    UNIQUE (tenant_id, parent_request_id)
);

CREATE INDEX IF NOT EXISTS privacy_request_appeals_tenant_parent_idx
    ON privacy_request_appeals (tenant_id, parent_request_id);
CREATE INDEX IF NOT EXISTS privacy_request_appeals_tenant_appeal_idx
    ON privacy_request_appeals (tenant_id, appeal_request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_request_appeals TO postwave_app;

ALTER TABLE privacy_request_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_request_appeals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON privacy_request_appeals;
CREATE POLICY tenant_isolation ON privacy_request_appeals
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON privacy_request_appeals;
CREATE POLICY tenant_visible ON privacy_request_appeals
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
