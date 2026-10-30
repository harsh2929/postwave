-- 1925_campaign_assurance_command_queue.sql
-- migration-execution: phased
--
-- Durable dispatch commands for Campaign Assurance. Public run creation and
-- worker execution are deliberately separated: a committed run can be
-- replay-enqueued with the same request identity, and a worker receives only
-- the exact tenant/run tuple needed to load the frozen manifest.
--
-- Commands use a fenced visibility lease. A crashed worker leaves the row
-- incomplete and it becomes claimable after lease expiry; an explicit retry
-- clears the lease and advances available_at. The immutable identity and
-- unique run/request fences make scheduler retries converge on one command.
--
-- rollback-strategy: no-op. Pending commands and completed dispatch receipts
-- are durable recovery/audit state and must survive an application rollback.

-- Required by the exact command-to-run foreign key. Existing uniqueness on
-- (tenant_id, campaign_id, id) and (tenant_id, campaign_id, request_id) is not
-- sufficient to prove that both values came from the same immutable run.
-- Build it without blocking production reads/writes on the existing run
-- ledger. The phased runner checkpoints this statement before the atomic
-- queue-table phase below.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_assurance_runs_command_identity_uidx
    ON campaign_assurance_runs (tenant_id, campaign_id, id, request_id);

BEGIN;

-- Fail a deploy instead of waiting indefinitely for a conflicting DDL lock.
SET LOCAL lock_timeout = '5s';

CREATE TABLE campaign_assurance_commands (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id             uuid NOT NULL,
    run_id                  uuid NOT NULL,
    request_id              uuid NOT NULL,
    available_at            timestamptz NOT NULL DEFAULT now(),
    lease_owner             uuid,
    lease_expires_at        timestamptz,
    delivery_attempt_count  integer NOT NULL DEFAULT 0 CHECK (
                                delivery_attempt_count >= 0
                            ),
    last_delivered_at       timestamptz,
    completed_at            timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_assurance_commands_run_identity_fk
        FOREIGN KEY (tenant_id, campaign_id, run_id, request_id)
        REFERENCES campaign_assurance_runs (
            tenant_id, campaign_id, id, request_id
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_commands_lease_shape_check CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR
        (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT campaign_assurance_commands_delivery_shape_check CHECK (
        (delivery_attempt_count = 0 AND last_delivered_at IS NULL)
        OR
        (delivery_attempt_count > 0 AND last_delivered_at IS NOT NULL)
    ),
    CONSTRAINT campaign_assurance_commands_terminal_shape_check CHECK (
        completed_at IS NULL
        OR (lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT campaign_assurance_commands_timestamp_order_check CHECK (
        available_at >= created_at
        AND (last_delivered_at IS NULL OR last_delivered_at >= created_at)
        AND (lease_expires_at IS NULL OR (
            last_delivered_at IS NOT NULL
            AND lease_expires_at > last_delivered_at
        ))
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND updated_at >= created_at
    ),
    UNIQUE (tenant_id, run_id),
    UNIQUE (tenant_id, campaign_id, request_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX campaign_assurance_commands_claimable_idx
    ON campaign_assurance_commands (available_at, created_at, id)
    WHERE completed_at IS NULL;

CREATE INDEX campaign_assurance_commands_tenant_history_idx
    ON campaign_assurance_commands (
        tenant_id, campaign_id, created_at DESC, id DESC
    );

CREATE OR REPLACE FUNCTION campaign_assurance_command_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'campaign assurance command identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'completed campaign assurance command is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_command_identity_immutable
    BEFORE UPDATE ON campaign_assurance_commands
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_command_identity_immutable();

COMMENT ON TABLE campaign_assurance_commands IS
    'Tenant-bound durable commands for leased execution of one immutable Campaign Assurance run.';
COMMENT ON COLUMN campaign_assurance_commands.delivery_attempt_count IS
    'Number of queue visibility leases acquired; assurance run attempts are fenced separately.';

GRANT SELECT, INSERT, UPDATE ON campaign_assurance_commands TO postwave_app;

ALTER TABLE campaign_assurance_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_commands FORCE ROW LEVEL SECURITY;

-- Public/API composition can inspect and append commands only inside the
-- active tenant. There is intentionally no tenant UPDATE or DELETE policy.
CREATE POLICY campaign_assurance_commands_tenant_select
    ON campaign_assurance_commands
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY campaign_assurance_commands_tenant_insert
    ON campaign_assurance_commands
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- Cross-tenant discovery is reserved for the exact assurance worker
-- capability. Requiring both the shared worker scope and this dedicated GUC
-- prevents unrelated outbox workers from enumerating or mutating commands.
CREATE POLICY campaign_assurance_commands_worker_select
    ON campaign_assurance_commands
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_assurance_worker', true) = 'true'
    );

CREATE POLICY campaign_assurance_commands_worker_update
    ON campaign_assurance_commands
    FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_assurance_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_assurance_worker', true) = 'true'
    );

COMMIT;
