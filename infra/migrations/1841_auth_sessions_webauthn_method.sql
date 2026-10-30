-- 1841_auth_sessions_webauthn_method.sql
--
-- AUTH-023 — allow 'webauthn' as an auth_sessions.auth_method. The original
-- inline CHECK (migration 0058) predates passkeys; a passkey login issues a
-- session with method 'webauthn', which would otherwise fail the CHECK on
-- INSERT. Widening the allowed set is the only change.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: CHECK widening is a superset; older code never writes
-- 'webauthn', so a rollback is safe once no such sessions exist.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_auth_method_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_auth_method_check
    CHECK (auth_method IN ('password', 'google', 'microsoft', 'saml', 'magic_link', 'webauthn'));

COMMIT;
