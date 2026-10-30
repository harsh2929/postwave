-- 0269_audit_portal.sql
--
-- audit-2026 (API, P1): embeddable customer-facing audit portal,
-- WorkOS Admin Portal pattern. A merchant of a sub-tenant calls
-- POST /api/v1/audit/portal/sessions to mint a short-lived JWT,
-- hands the resulting portal_url to a customer, and the customer
-- loads the slim, read-only audit SPA inside
-- an iframe (or directly in a browser).
--
-- Security evolution: migration 1713 supersedes the original token-in-path
-- transport. Current links use /portal/audit#bootstrap=<jwt>; the SPA scrubs
-- the fragment and atomically exchanges it once for a distinct HttpOnly
-- cookie whose digest is checked in this table on every read.
--
-- Why a signed bootstrap instead of an opaque token?
--
--   * Signature validation rejects forgery before the atomic DB exchange.
--   * Tenant and scope claims are cross-checked against durable state.
--
-- Why a session table on top?
--
--   * Lets the admin revoke a customer-shared link (revoked_at).
--   * Captures first-access IP + timestamp for incident response.
--   * Enables rate-limiting "active sessions per tenant" so a
--     leaked merchant token can't fan out unbounded sub-portals.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_portal_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    -- token_hash = sha256(jwt) hex. We deliberately do NOT store the
    -- raw JWT — only its digest, so a DB leak doesn't yield a valid
    -- portal credential. The token itself only lives in the response
    -- body of POST /portal/sessions.
    token_hash    text NOT NULL,
    -- audit:read is the only scope a portal session ever carries
    -- today; column kept for forward-compat with sub-tenant scoping.
    scope         text NOT NULL DEFAULT 'audit:read',
    -- sub_tenant_id lets a parent tenant carve out a child slice for
    -- the portal; when NULL the session sees the parent's own log.
    sub_tenant_id uuid,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,                    -- user / API key who minted the session
    accessed_at   timestamptz,             -- first SPA load
    ip_accessed   inet,                    -- IP of first SPA load
    revoked_at    timestamptz,             -- admin revocation
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_audit_portal_sessions_tenant_active
    ON audit_portal_sessions (tenant_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_portal_sessions_token
    ON audit_portal_sessions (token_hash)
    WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON audit_portal_sessions TO postwave_app;

ALTER TABLE audit_portal_sessions ENABLE ROW LEVEL SECURITY;

-- Standard tenant-GUC policy. The NULLIF idiom guards against the
-- GUC being unset (raw cast crashes on '').
CREATE POLICY tenant_visible ON audit_portal_sessions AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The audit middleware automatically captures `audit.portal.session_create`
-- and `audit.portal.session_access` events through the action-string
-- routing, no extra column required on audit_log.

COMMIT;
