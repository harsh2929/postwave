-- 0023_approvals.sql
--
-- Agent-safety approval gates. Mutating operations that an agent (or any
-- caller) flags as `requires_approval` short-circuit into a row here and
-- wait for a human admin to approve or reject before the underlying action
-- (campaign send, sequence start, automation_send step) actually runs.
--
-- Per LICENSE-BOUNDARY.md this lives in the proprietary gateway DB, never
-- in Listmonk's database.

BEGIN;

CREATE TABLE approvals (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    resource_type               text NOT NULL CHECK (resource_type IN ('campaign','sequence','automation_send')),
    resource_id                 uuid NOT NULL,
    requested_by_actor_type     text,
    requested_by_actor_label    text,
    requested_by_api_key_id     uuid,
    status                      text NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','approved','rejected','expired')),
    requested_at                timestamptz NOT NULL DEFAULT now(),
    decided_at                  timestamptz,
    decided_by_user_id          uuid,
    notes                       text,
    expires_at                  timestamptz NOT NULL
);

CREATE INDEX approvals_tenant_status_requested_idx
    ON approvals (tenant_id, status, requested_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON approvals TO postwave_app;

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON approvals
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public one-click decide lookup. The HMAC token is verified before the
-- repository runs this query, and the repository binds the exact approval id
-- into app.public_approval_id for the transaction.
CREATE POLICY approvals_public_lookup ON approvals
    FOR SELECT
    USING (id = NULLIF(current_setting('app.public_approval_id', true), '')::uuid);

CREATE POLICY approvals_public_decide ON approvals
    FOR UPDATE
    USING (
        id = NULLIF(current_setting('app.public_approval_id', true), '')::uuid
        AND status = 'pending'
    )
    WITH CHECK (
        id = NULLIF(current_setting('app.public_approval_id', true), '')::uuid
        AND status IN ('approved', 'rejected', 'expired')
    );

-- Background expiry sweep is tenantless but still explicitly scoped by a
-- transaction-local guard value before it can update expired pending rows.
CREATE POLICY approvals_expiry_sweep ON approvals
    FOR UPDATE
    USING (
        current_setting('app.approvals_expiry_sweep', true) = '1'
        AND status = 'pending'
        AND expires_at < now()
    )
    WITH CHECK (
        current_setting('app.approvals_expiry_sweep', true) = '1'
        AND status = 'expired'
        AND expires_at < now()
    );

COMMIT;
