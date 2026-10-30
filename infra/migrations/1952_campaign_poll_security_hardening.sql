-- 1952_campaign_poll_security_hardening.sql
--
-- F14 containment: make poll relations tenant-owned at the database boundary,
-- force RLS for table owners, and make "counted" mean explicitly human.
-- Runtime token v2 separately binds the tenant into every HMAC; old unbound
-- links intentionally fail closed after deployment.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Runtime v2 tokens are intentionally not backward
-- compatible. Reverting requires disabling poll routes before restoring the old
-- state vocabulary or foreign keys. Replacement indexes are built before any
-- legacy uniqueness is removed, so an interrupted migration fails closed.

-- Composite parent identities and the tenant-scoped replacement token fence
-- are built online before the constraint transaction. CONCURRENTLY cannot run
-- inside BEGIN/COMMIT.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_tenant_id_id_uidx
    ON campaign_polls (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_poll_options_tenant_poll_id_id_uidx
    ON campaign_poll_options (tenant_id, poll_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_poll_responses_tenant_token_uniq
    ON campaign_poll_responses (tenant_id, token_hash);

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE campaign_poll_responses
    ADD COLUMN IF NOT EXISTS confirmation_token_hash text,
    ADD COLUMN IF NOT EXISTS confirmation_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirmation_used_at timestamptz;

ALTER TABLE campaign_polls
    DROP CONSTRAINT IF EXISTS campaign_polls_campaign_id_fkey,
    DROP CONSTRAINT IF EXISTS campaign_polls_tenant_campaign_fkey,
    ADD CONSTRAINT campaign_polls_tenant_campaign_fkey
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE SET NULL (campaign_id)
        NOT VALID;

ALTER TABLE campaign_poll_options
    DROP CONSTRAINT IF EXISTS campaign_poll_options_poll_id_fkey,
    DROP CONSTRAINT IF EXISTS campaign_poll_options_tenant_poll_fkey,
    ADD CONSTRAINT campaign_poll_options_tenant_poll_fkey
        FOREIGN KEY (tenant_id, poll_id)
        REFERENCES campaign_polls (tenant_id, id)
        ON DELETE CASCADE
        NOT VALID;

ALTER TABLE campaign_poll_responses
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_poll_id_fkey,
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_option_id_fkey,
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_tenant_poll_fkey,
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_tenant_poll_option_fkey,
    ADD CONSTRAINT campaign_poll_responses_tenant_poll_fkey
        FOREIGN KEY (tenant_id, poll_id)
        REFERENCES campaign_polls (tenant_id, id)
        ON DELETE CASCADE
        NOT VALID,
    ADD CONSTRAINT campaign_poll_responses_tenant_poll_option_fkey
        FOREIGN KEY (tenant_id, poll_id, option_id)
        REFERENCES campaign_poll_options (tenant_id, poll_id, id)
        ON DELETE CASCADE
        NOT VALID;

ALTER TABLE campaign_polls
    VALIDATE CONSTRAINT campaign_polls_tenant_campaign_fkey;
ALTER TABLE campaign_poll_options
    VALIDATE CONSTRAINT campaign_poll_options_tenant_poll_fkey;
ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_tenant_poll_fkey;
ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_tenant_poll_option_fkey;

-- Expand the state vocabulary before repairing legacy rows. Updating a row to
-- unclassified_excluded while migration 1945's old CHECK is still installed
-- fails the upgrade before the replacement constraint can be reached.
ALTER TABLE campaign_poll_responses
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_state_check,
    ADD CONSTRAINT campaign_poll_responses_state_check CHECK (
        state IN (
            'previewed',
            'counted',
            'machine_excluded',
            'unclassified_excluded',
            'voided_multi_option'
        )
    ) NOT VALID;

-- Rows produced by the pre-hardening runtime sometimes called an unknown or
-- absent classification "counted". Preserve the evidence but remove it from
-- the human tally before installing the stronger evidence-shape contract.
UPDATE campaign_poll_responses
   SET classification = 'unknown',
       state = 'unclassified_excluded',
       updated_at = now()
 WHERE confirmed_at IS NOT NULL
   AND state = 'counted'
   AND classification IS DISTINCT FROM 'human';

UPDATE campaign_poll_responses
   SET classification = 'unknown',
       updated_at = now()
 WHERE confirmed_at IS NOT NULL
   AND classification IS NULL;

ALTER TABLE campaign_poll_responses
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_evidence_shape_check,
    ADD CONSTRAINT campaign_poll_responses_evidence_shape_check CHECK (
        (state = 'previewed'
            AND confirmed_at IS NULL)
        OR
        (state = 'counted'
            AND confirmed_at IS NOT NULL
            AND classification = 'human')
        OR
        (state = 'machine_excluded'
            AND confirmed_at IS NOT NULL
            AND classification = 'machine')
        OR
        (state = 'unclassified_excluded'
            AND confirmed_at IS NOT NULL
            AND classification = 'unknown')
        OR
        (state = 'voided_multi_option'
            AND confirmed_at IS NOT NULL
            AND classification IS NOT NULL)
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS campaign_poll_responses_confirmation_shape_check,
    ADD CONSTRAINT campaign_poll_responses_confirmation_shape_check CHECK (
        (confirmation_token_hash IS NULL
            AND confirmation_expires_at IS NULL
            AND confirmation_used_at IS NULL)
        OR
        (confirmation_token_hash ~ '^[0-9a-f]{64}$'
            AND confirmation_expires_at IS NOT NULL
            AND (confirmation_used_at IS NULL
                OR confirmation_used_at <= confirmed_at))
    ) NOT VALID;

ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_state_check;
ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_evidence_shape_check;
ALTER TABLE campaign_poll_responses
    VALIDATE CONSTRAINT campaign_poll_responses_confirmation_shape_check;

-- Token v2 includes tenant_id, and storage uniqueness follows the same scope.
-- The replacement was built and validated by PostgreSQL before this transaction
-- began, so dropping the legacy global fence cannot leave an unguarded window.
DROP INDEX IF EXISTS campaign_poll_responses_token_uniq;

ALTER TABLE campaign_polls FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_poll_options FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_poll_responses FORCE ROW LEVEL SECURITY;

COMMIT;
