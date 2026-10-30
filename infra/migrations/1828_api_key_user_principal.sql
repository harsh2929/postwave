-- 1828_api_key_user_principal.sql
--
-- Bind API keys to the dashboard user that created them. MCP/API-key calls
-- can then exercise user-private state (favorites, recent templates,
-- collections, saved searches) without accepting an impersonable user_id
-- argument. Existing keys deliberately remain unbound because their creator
-- cannot be reconstructed safely; rotate or recreate them from an
-- authenticated dashboard session to opt into user-private state.
--
-- rollback-strategy: no-op
-- rollback-details: the nullable principal is additive identity provenance.

BEGIN;

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS user_id uuid;

ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_tenant_user_principal_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES users(tenant_id, id)
    ON DELETE CASCADE;

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS api_keys_user_principal_idx
    ON api_keys (tenant_id, user_id)
    WHERE user_id IS NOT NULL;

BEGIN;

COMMENT ON COLUMN api_keys.user_id IS
    'Verified dashboard creator for user-private API/MCP state; legacy keys remain NULL.';

COMMIT;
