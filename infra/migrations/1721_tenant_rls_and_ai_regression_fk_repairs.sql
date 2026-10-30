-- 1721_tenant_rls_and_ai_regression_fk_repairs.sql
--
-- Forward-only repair for migration-lint findings discovered during the
-- 2026-07 production-readiness audit. OAuth/CLI exchange rows remain usable
-- before tenant resolution, but access is now restricted to the SHA-256 hash
-- of the one-time secret bound transaction-locally by the API.
--
-- rollback-strategy: no-op - keep the isolation/FK repair in place when the
-- previous application image is restored.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'ai_regression_results'::regclass
           AND conname = 'ai_regression_results_tenant_id_fkey'
    ) THEN
        ALTER TABLE ai_regression_results
            ADD CONSTRAINT ai_regression_results_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES tenants(id)
            ON DELETE CASCADE
            NOT VALID;
    END IF;
END
$$;

-- Fail closed if historical data contains an orphan tenant. The NOT VALID
-- addition above keeps the constraint-install lock short; validation performs
-- the existing-row scan under PostgreSQL's lower-impact validation lock.
ALTER TABLE ai_regression_results
    VALIDATE CONSTRAINT ai_regression_results_tenant_id_fkey;

ALTER TABLE subscriber_note_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE transactional_emails FORCE ROW LEVEL SECURITY;
ALTER TABLE transactional_smtp_dedup FORCE ROW LEVEL SECURITY;

ALTER TABLE crm_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oauth_state_secret_or_tenant ON crm_oauth_states;
CREATE POLICY oauth_state_secret_or_tenant ON crm_oauth_states
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR state_hash = NULLIF(current_setting('app.oauth_state_hash', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR state_hash = NULLIF(current_setting('app.oauth_state_hash', true), '')
    );

ALTER TABLE marketing_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oauth_state_secret_or_tenant ON marketing_oauth_states;
CREATE POLICY oauth_state_secret_or_tenant ON marketing_oauth_states
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR state_hash = NULLIF(current_setting('app.oauth_state_hash', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR state_hash = NULLIF(current_setting('app.oauth_state_hash', true), '')
    );

ALTER TABLE cli_auth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cli_auth_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cli_grant_secret_or_tenant ON cli_auth_grants;
CREATE POLICY cli_grant_secret_or_tenant ON cli_auth_grants
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR code_hash = NULLIF(current_setting('app.cli_grant_hash', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR code_hash = NULLIF(current_setting('app.cli_grant_hash', true), '')
    );

COMMIT;
