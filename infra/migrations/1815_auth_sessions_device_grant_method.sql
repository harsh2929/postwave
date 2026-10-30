-- 1815_auth_sessions_device_grant_method.sql
--
-- AUTH#52 companion to 1816. auth_sessions.auth_method has carried a closed
-- vocabulary since 0058 ('password','google','microsoft','saml','magic_link'),
-- and a session issued by an RFC 8628 device grant is none of those.
--
-- The alternative — recording a QR-approved sign-in as 'password' — would put
-- a lie in the one place the user goes to answer "is this login me?": the
-- active-sessions list renders auth_method verbatim. A device grant is a
-- materially different assurance story (approved from an already-signed-in
-- phone, no credential re-entry), so it gets its own value.
--
-- Widening a CHECK is strictly permissive: every row that satisfied the old
-- constraint satisfies the new one, so this needs no backfill and no rewrite
-- beyond the validation scan.
--
-- ORDERING: deploy this BEFORE the code that writes 'device_grant'. Until it
-- lands, a session-kind device grant fails closed with a constraint violation
-- (the session is simply not issued) rather than writing a bad row.
--
-- rollback-strategy: restore the narrower CHECK, but ONLY after deleting or
-- rewriting any 'device_grant' rows —
--   DELETE FROM auth_sessions WHERE auth_method = 'device_grant';
--   ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_auth_method_check;
--   ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_auth_method_check
--       CHECK (auth_method IN ('password','google','microsoft','saml','magic_link'));
-- Revoking those sessions is the correct rollback: they were issued by a
-- feature that is being withdrawn.

BEGIN;

ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_auth_method_check;

ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_auth_method_check
    CHECK (auth_method IN (
        'password', 'google', 'microsoft', 'saml', 'magic_link', 'device_grant'
    ));

COMMIT;
