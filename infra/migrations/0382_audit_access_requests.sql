-- 0382_audit_access_requests.sql
--
-- desktop-audit gap A14 (Audit "Request access" flow)
--
-- Users without the audit:read scope land on the audit page and see a
-- locked state. This table backs the "Request access" CTA: the request
-- row records who asked, when, and an optional note; tenant owners /
-- admins review pending rows via GET /api/v1/audit/access-requests.
--
-- There is intentionally NO in-app notification fan-out here — the
-- codebase has no notification-create mechanism today (the
-- notifications package is a pref *gate* only, and audit_export_worker
-- deliberately avoided a system_notifications table for the same
-- reason). Owners discover requests through the owner-visible list +
-- the audit.access_request.created audit row the handler emits.
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair using the
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom
-- (raw ::uuid cast crashes when the GUC is unset).

BEGIN;

CREATE TABLE IF NOT EXISTS audit_access_requests (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Nullable: API-key callers carry no dashboard user. For those we
    -- persist the actor label instead so the owner still sees who asked.
    requested_by       UUID,
    requested_by_email TEXT,
    actor_label        TEXT,
    note               TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','dismissed')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_access_requests_tenant_status
    ON audit_access_requests (tenant_id, status, created_at DESC);

-- One open request per user per tenant — re-clicking the CTA is
-- idempotent instead of piling up duplicate pending rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_access_requests_pending_user
    ON audit_access_requests (tenant_id, requested_by)
    WHERE status = 'pending' AND requested_by IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_access_requests TO postwave_app;

ALTER TABLE audit_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_access_requests FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_access_requests
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON audit_access_requests
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
