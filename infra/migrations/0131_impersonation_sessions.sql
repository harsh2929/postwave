-- 0131_impersonation_sessions.sql
--
-- Tenant impersonation for support engineers.
--
-- An operator (Postwave employee with the platform_support role)
-- starts an impersonation session by POSTing to
-- /api/internal/impersonate/start with the target tenant id + a
-- reason. The server mints a short-lived token, persists the
-- session row, and writes an audit_log entry. The operator then
-- attaches that token as `X-Postwave-Impersonation` on subsequent
-- requests; the impersonation middleware swaps the tenant context
-- to the target tenant + clamps the scope.
--
-- Safeguards baked into the schema:
--
--   * expires_at NOT NULL — sessions auto-expire (default 1 hour).
--     A worker prunes sessions where expires_at < now() so stale
--     tokens stop working immediately even if the operator forgets
--     to End.
--
--   * scope text CHECK — 'read_only' or 'read_write'. The
--     middleware refuses non-GET methods when scope='read_only'.
--
--   * audit_start_id / audit_end_id — pointers to the audit_log
--     entries the impersonation lifecycle wrote. Lets the security
--     team correlate "we impersonated tenant X" with the actions
--     that operator subsequently performed under the token.
--
-- Why a dedicated table rather than re-using sessions: support
-- impersonation is a security-sensitive surface that's audited
-- DIFFERENTLY from regular login sessions. Auditors review this
-- table specifically; a separate table makes that review easy + a
-- separate retention policy possible.

BEGIN;

CREATE TABLE IF NOT EXISTS impersonation_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Operator (Postwave employee) running the session. Stored as
    -- text because the operator identity comes from the internal
    -- admin SSO, not from the users table (which is tenant-scoped).
    operator_email      text NOT NULL,
    -- Target tenant the operator is acting as.
    target_tenant_id    uuid NOT NULL,
    -- sha256 of the raw bearer token. The raw token is returned
    -- ONCE on /impersonate/start and never re-emitted.
    token_sha256        bytea NOT NULL UNIQUE,
    token_prefix        text NOT NULL,
    scope               text NOT NULL DEFAULT 'read_only'
                              CHECK (scope IN ('read_only','read_write')),
    reason              text NOT NULL,
    started_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    ended_at            timestamptz,
    ended_reason        text,
    -- Audit pointers — populated by the impersonate handler when
    -- it writes the start/end audit_log rows.
    audit_start_id      bigint,
    audit_end_id        bigint
);

CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_active
    ON impersonation_sessions (token_sha256)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_target
    ON impersonation_sessions (target_tenant_id, started_at DESC);

-- Public read access for ops dashboards. Writes only via the
-- internal admin handler (which connects with elevated grants in
-- the migration runner; the app role doesn't INSERT directly).
GRANT SELECT, INSERT, UPDATE ON impersonation_sessions TO postwave_app;

-- NO row-level security on this table: impersonation is a global
-- support surface. The internal admin handler is the only writer
-- and it's mounted on the internal router (Cloudflare allowlisted).

COMMIT;
