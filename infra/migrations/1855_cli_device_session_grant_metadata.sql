-- 1855_cli_device_session_grant_metadata.sql
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Keep the nullable metadata, constraints, indexes, and
-- user-lifecycle revocation trigger on application rollback. They are
-- compatible with legacy API-key grants and deliberately make old API
-- replicas fail closed when shown a session grant.
--
-- Generalise the RFC 8628 CLI grant for cross-device browser sign-in while
-- preserving every legacy CLI default. Target identity is transport metadata,
-- never an authorization input supplied in JSON. The session that authorizes
-- approval remains live authority until the target proves receipt of the exact
-- provisional cookie.
--
-- The session state constraints are also the rolling-deploy fence. A legacy
-- replica does not understand grant_kind: it would otherwise approve a new
-- session row without approved_session_id and then consume it into an API key.
-- Requiring authority metadata at approved and issued-session metadata at
-- consumed makes both legacy writes fail atomically. Apply this migration
-- before any replica is allowed to create session grants.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE cli_device_grants
    ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS target_user_agent text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS target_native_client text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS target_ip inet,
    ADD COLUMN IF NOT EXISTS denied_at timestamptz,
    ADD COLUMN IF NOT EXISTS approved_session_id text,
    ADD COLUMN IF NOT EXISTS issued_session_id text,
    ADD COLUMN IF NOT EXISTS session_confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS session_confirmation_expires_at timestamptz;

ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS device_grant_confirmed_at timestamptz;

DO $constraints$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_approved_session_fkey'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_approved_session_fkey
            FOREIGN KEY (approved_session_id) REFERENCES auth_sessions(id)
            ON DELETE CASCADE NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_issued_session_fkey'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_issued_session_fkey
            FOREIGN KEY (issued_session_id) REFERENCES auth_sessions(id)
            ON DELETE CASCADE NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_remember_session_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_remember_session_check
            CHECK (NOT remember OR grant_kind = 'session') NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_target_native_client_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_target_native_client_check
            CHECK (target_native_client IN ('', 'mobile', 'desktop')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_approved_session_kind_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_approved_session_kind_check
            CHECK (approved_session_id IS NULL OR grant_kind = 'session') NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_issued_session_kind_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_issued_session_kind_check
            CHECK (issued_session_id IS NULL OR grant_kind = 'session') NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_session_authority_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_session_authority_check CHECK (
                grant_kind <> 'session'
                OR status NOT IN ('approved', 'consumed')
                OR (
                    tenant_id IS NOT NULL
                    AND user_id IS NOT NULL
                    AND approved_session_id IS NOT NULL
                )
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_session_consumption_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_session_consumption_check CHECK (
                grant_kind <> 'session'
                OR status <> 'consumed'
                OR (
                    issued_session_id IS NOT NULL
                    AND session_confirmation_expires_at IS NOT NULL
                )
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'cli_device_grants'::regclass
           AND conname = 'cli_device_grants_session_confirmation_check'
    ) THEN
        ALTER TABLE cli_device_grants
            ADD CONSTRAINT cli_device_grants_session_confirmation_check CHECK (
                session_confirmed_at IS NULL
                OR (grant_kind = 'session' AND issued_session_id IS NOT NULL)
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'auth_sessions'::regclass
           AND conname = 'auth_sessions_device_grant_confirmation_check'
    ) THEN
        ALTER TABLE auth_sessions
            ADD CONSTRAINT auth_sessions_device_grant_confirmation_check
            CHECK (
                device_grant_confirmed_at IS NULL
                OR auth_method = 'device_grant'
            ) NOT VALID;
    END IF;
END
$constraints$;

-- Migration 1841 widened an older baseline and accidentally removed the
-- already-shipped device_grant and workspace_switch values. Replace it with
-- the complete vocabulary, but defer the historical scan to a later phase.
ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_auth_method_check;
ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_auth_method_check
    CHECK (auth_method IN (
        'password', 'google', 'microsoft', 'saml', 'magic_link',
        'device_grant', 'workspace_switch', 'webauthn'
    )) NOT VALID;

-- Suspension/deletion must be monotonic for authentication. Merely hiding a
-- session while users.status is inactive lets every unexpired session and MFA
-- trust credential resurrect if the member is later reactivated. Revoke on
-- BOTH sides of every active/non-active transition: the OLD-side check also
-- catches dormant credentials belonging to users who were already suspended
-- before this migration and are subsequently reactivated. The trigger runs in
-- the same tenant-scoped transaction as the lifecycle change, so a successful
-- status transition has already revoked both credential classes.
CREATE OR REPLACE FUNCTION public.revoke_user_auth_on_deactivation_1855()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF OLD.status <> 'active' OR NEW.status <> 'active' THEN
        UPDATE public.auth_sessions
           SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id;

        UPDATE public.auth_trusted_devices
           SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS users_revoke_auth_on_deactivation_1855 ON users;
CREATE TRIGGER users_revoke_auth_on_deactivation_1855
AFTER UPDATE OF status ON users
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.revoke_user_auth_on_deactivation_1855();

-- Ordinary application transactions cannot enumerate all grants. The worker
-- opens this narrow SELECT+DELETE path with a transaction-local GUC.
DROP POLICY IF EXISTS cli_device_grant_janitor_select ON cli_device_grants;
CREATE POLICY cli_device_grant_janitor_select ON cli_device_grants
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.cli_device_grant_janitor', true) = 'true');

DROP POLICY IF EXISTS cli_device_grant_janitor_delete ON cli_device_grants;
CREATE POLICY cli_device_grant_janitor_delete ON cli_device_grants
    AS PERMISSIVE FOR DELETE TO postwave_app
    USING (current_setting('app.cli_device_grant_janitor', true) = 'true');

COMMIT;

-- Foreign-key actions and retention sweeps must not scan the retained grant
-- set while deleting/reaping an auth session. Build online after the columns
-- are committed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS cli_device_grants_approved_session_idx
    ON cli_device_grants (approved_session_id)
    WHERE approved_session_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS cli_device_grants_issued_session_idx
    ON cli_device_grants (issued_session_id)
    WHERE issued_session_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS cli_device_grants_unconfirmed_cleanup_idx
    ON cli_device_grants (session_confirmation_expires_at)
    WHERE grant_kind = 'session' AND status = 'consumed'
      AND session_confirmed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS cli_device_grants_confirmed_cleanup_idx
    ON cli_device_grants (session_confirmed_at)
    WHERE grant_kind = 'session' AND status = 'consumed'
      AND session_confirmed_at IS NOT NULL;

-- NOT VALID enforced every write from phase one. Validation here scans old
-- rows without holding the hot auth_sessions table behind the DDL cutover.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_approved_session_fkey;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_issued_session_fkey;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_remember_session_check;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_target_native_client_check;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_approved_session_kind_check;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_issued_session_kind_check;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_session_authority_check;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_session_consumption_check;
ALTER TABLE cli_device_grants
    VALIDATE CONSTRAINT cli_device_grants_session_confirmation_check;
ALTER TABLE auth_sessions
    VALIDATE CONSTRAINT auth_sessions_device_grant_confirmation_check;
ALTER TABLE auth_sessions
    VALIDATE CONSTRAINT auth_sessions_auth_method_check;

COMMIT;
