-- 1817_auth_sessions_workspace_switch_method.sql
-- migration-execution: single-phase
-- rollback-strategy: additive (CHECK widening)
--
-- AUTH#6. POST /api/v1/auth/workspaces/switch mints a session in a SIBLING
-- workspace from an existing, email-verified session — the in-app workspace
-- switcher that mobile has never had, because until now the only way to change
-- workspace was a full sign-out plus a password re-entry.
--
-- auth_sessions.auth_method has carried a closed vocabulary since 0058, widened
-- once by 1815 for 'device_grant'. A switched session is none of the existing
-- values, and recording it as 'password' would put a lie in the one place the
-- user goes to answer "is this login me?" — the active-sessions list renders
-- auth_method verbatim. It is also a materially different assurance story: no
-- credential was presented, the authority came from a sibling session whose
-- mailbox ownership was already proven, and the new session is deliberately
-- NOT mfa_satisfied so the target tenant's MFA policy re-challenges.
--
-- Widening a CHECK is strictly permissive: every row that satisfied the old
-- constraint satisfies the new one, so this needs no backfill and no rewrite
-- beyond the validation scan.
--
-- ORDERING: deploy this BEFORE the code that writes 'workspace_switch'. Until
-- it lands, a switch fails closed with a constraint violation (the session is
-- simply not issued, and the handler answers 500 session_failed) rather than
-- writing a row the constraint was meant to exclude.
--
-- rollback-details: restore the narrower CHECK, but ONLY after deleting or
-- rewriting any 'workspace_switch' rows —
--   DELETE FROM auth_sessions WHERE auth_method = 'workspace_switch';
--   ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_auth_method_check;
--   ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_auth_method_check
--       CHECK (auth_method IN ('password','google','microsoft','saml',
--                              'magic_link','device_grant'));
-- Revoking those sessions is the correct rollback: they were issued by a
-- feature that is being withdrawn.

BEGIN;

ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_auth_method_check;

ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_auth_method_check
    CHECK (auth_method IN (
        'password', 'google', 'microsoft', 'saml', 'magic_link',
        'device_grant', 'workspace_switch'
    ));

COMMIT;
