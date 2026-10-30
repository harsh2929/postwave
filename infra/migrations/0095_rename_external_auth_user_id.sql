-- 0095_rename_external_auth_user_id.sql
--
-- The original users table predated first-party Postwave auth and named the
-- optional upstream IdP id `clerk_user_id`. Production auth is now native
-- password/OAuth/SAML, so keep the nullable external identity slot but rename
-- it to provider-neutral terminology.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'clerk_user_id'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'external_user_id'
    ) THEN
        ALTER TABLE users RENAME COLUMN clerk_user_id TO external_user_id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_clerk_user_id_key'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_external_user_id_key'
    ) THEN
        ALTER TABLE users RENAME CONSTRAINT users_clerk_user_id_key TO users_external_user_id_key;
    END IF;
END $$;

COMMENT ON COLUMN users.external_user_id IS
    'Optional upstream identity-provider user id for OAuth/SAML accounts. NULL for native password users.';

COMMIT;
