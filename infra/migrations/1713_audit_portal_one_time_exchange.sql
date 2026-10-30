-- B-16: remove audit-portal credentials from HTTP URLs. The link now carries
-- a bootstrap JWT only in its fragment; a single atomic exchange records the
-- consumption and stores only the digest of a distinct HttpOnly cookie token.

BEGIN;

ALTER TABLE audit_portal_sessions
    ADD COLUMN IF NOT EXISTS exchanged_at timestamptz,
    ADD COLUMN IF NOT EXISTS session_token_hash text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'audit_portal_sessions_exchange_pair'
           AND conrelid = 'audit_portal_sessions'::regclass
    ) THEN
        ALTER TABLE audit_portal_sessions
            ADD CONSTRAINT audit_portal_sessions_exchange_pair
            CHECK ((exchanged_at IS NULL) = (session_token_hash IS NULL));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'audit_portal_sessions_cookie_hash_shape'
           AND conrelid = 'audit_portal_sessions'::regclass
    ) THEN
        ALTER TABLE audit_portal_sessions
            ADD CONSTRAINT audit_portal_sessions_cookie_hash_shape
            CHECK (session_token_hash IS NULL OR session_token_hash ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

ALTER TABLE audit_portal_sessions FORCE ROW LEVEL SECURITY;

COMMIT;

-- The exchange indexes are created concurrently by migration 1716. They are
-- intentionally separate from this atomic column/constraint migration so a
-- busy portal session table is never locked for a conventional index build.
