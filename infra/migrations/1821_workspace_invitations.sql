-- 1821_workspace_invitations.sql
--
-- SETC-010 — workspace team management. A pending invitation to join an
-- EXISTING workspace with a fixed role. The copy-link model: the invite
-- carries a single-use, hashed, expiring token; the admin shares the link,
-- and the invitee accepts it by setting a password (POST /api/v1/auth/
-- accept-invite), which creates their users row in this tenant with the
-- invited role. Only SHA-256(token) is stored — the plaintext is returned
-- exactly once at creation, mirroring auth_tokens (repo.go IssueToken).
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: The table is additive; older application versions never
-- read it. Drop is safe once no in-flight invitations matter.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS team_invitations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email                 citext NOT NULL,
    role                  text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    -- SHA-256 of the copy-link token; never the plaintext.
    token_hash            bytea NOT NULL,
    invited_by_user_id    uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    expires_at            timestamptz NOT NULL,
    accepted_at           timestamptz,
    accepted_by_user_id   uuid,
    CONSTRAINT team_invitations_email_check CHECK (length(btrim(email::text)) > 0)
);

-- The accept lookup is by token hash across all tenants (the invitee has no
-- session yet), so the hash must be globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS team_invitations_token_hash_uniq
    ON team_invitations (token_hash);

-- At most one live (unaccepted) invite per email per workspace, so re-inviting
-- an address does not mint duplicates. Accepted rows are retained for audit.
CREATE UNIQUE INDEX IF NOT EXISTS team_invitations_pending_email_uniq
    ON team_invitations (tenant_id, lower(email::text))
    WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS team_invitations_tenant_pending_idx
    ON team_invitations (tenant_id, created_at DESC)
    WHERE accepted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON team_invitations TO postwave_app;

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON team_invitations;
CREATE POLICY tenant_isolation ON team_invitations
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The invitee has no session, so the accept path looks the invitation up by
-- token hash BEFORE any tenant is known. This permissive resolver policy —
-- identical to auth_tokens.auth_resolver_all — opens cross-tenant read/write
-- only inside a withResolverGUC() transaction (app.auth_resolver='true'),
-- exactly as ConsumeToken redeems auth_tokens. Ordinary requests never set
-- that GUC, so tenant_isolation remains the only active policy for them.
DROP POLICY IF EXISTS auth_resolver_all ON team_invitations;
CREATE POLICY auth_resolver_all ON team_invitations
    USING (current_setting('app.auth_resolver', true) = 'true')
    WITH CHECK (current_setting('app.auth_resolver', true) = 'true');

COMMIT;
