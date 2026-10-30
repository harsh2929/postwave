-- 0031_migration_control_state.sql
--
-- Durable control-plane state for migrations. migration_jobs already tracks
-- user-visible progress; these tables keep OAuth CSRF states and source
-- sessions restart-safe without storing bearer tokens in process memory.

BEGIN;

CREATE TABLE IF NOT EXISTS migration_oauth_states (
    state       text PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS migration_oauth_states_tenant_idx
    ON migration_oauth_states (tenant_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS migration_oauth_states_expiry_idx
    ON migration_oauth_states (expires_at)
    WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_oauth_states TO postwave_app;

ALTER TABLE migration_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_oauth_states;
CREATE POLICY tenant_isolation ON migration_oauth_states
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS migration_sessions (
    job_id      uuid PRIMARY KEY REFERENCES migration_jobs(id) ON DELETE CASCADE,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source      text NOT NULL,
    ciphertext  bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS migration_sessions_tenant_idx
    ON migration_sessions (tenant_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS migration_sessions_expiry_idx
    ON migration_sessions (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_sessions TO postwave_app;

ALTER TABLE migration_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration_sessions;
CREATE POLICY tenant_isolation ON migration_sessions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
