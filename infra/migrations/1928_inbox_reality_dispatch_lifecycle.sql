-- 1928_inbox_reality_dispatch_lifecycle.sql
--
-- One authoritative Inbox Reality lifecycle. The API gateway atomically binds
-- a public test to an immutable render artifact and a durable execution
-- command. A dedicated cross-tenant worker leases that command and calls the
-- deliverability service. The service freezes its active controlled-seed
-- capability snapshot before provider calls and records one fenced delivery
-- row per mailbox. Sanitized observation callbacks converge into the existing
-- customer-facing result projection under the gateway-issued test id.
--
-- No recipient address, seed credential, raw MIME, or provider UI summary is
-- stored in these tables. Provider message ids and received MIME identifiers
-- are irreversibly reduced before persistence.
--
-- rollback-strategy: no-op. Dispatch/observation receipts are durable evidence
-- and must remain readable after an application rollback.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Exact composite identities let foreign keys prove that independently valid
-- UUIDs came from the same gateway-issued test/artifact bundle.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_reality_tests_dispatch_identity_uidx
    ON inbox_reality_tests (
        tenant_id, id, campaign_id, content_revision_id, send_plan_id, artifact_id
    );

CREATE TABLE inbox_reality_dispatch_commands (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    test_id                    uuid NOT NULL,
    idempotency_key            text NOT NULL CHECK (
                                   length(idempotency_key) BETWEEN 1 AND 200
                                   AND idempotency_key !~ '[[:cntrl:]]'
                               ),
    request_hash               text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    campaign_id                uuid NOT NULL,
    content_revision_id        uuid NOT NULL,
    send_plan_id               uuid NOT NULL,
    artifact_id                uuid NOT NULL,
    scenario_id                text NOT NULL CHECK (length(scenario_id) BETWEEN 1 AND 200),
    artifact_mime_object_ref   text NOT NULL CHECK (
                                   length(artifact_mime_object_ref) BETWEEN 1 AND 2000
                                   AND artifact_mime_object_ref !~ '[[:space:]]'
                               ),
    artifact_mime_hash         text NOT NULL CHECK (artifact_mime_hash ~ '^[0-9a-f]{64}$'),
    artifact_structure_hash    text NOT NULL CHECK (artifact_structure_hash ~ '^[0-9a-f]{64}$'),
    requested_capabilities     jsonb NOT NULL CHECK (jsonb_typeof(requested_capabilities) = 'object'),
    state                      text NOT NULL DEFAULT 'queued' CHECK (state IN (
                                   'queued', 'leased', 'retry_wait', 'dispatched',
                                   'failed', 'expired', 'cancelled'
                               )),
    available_at               timestamptz NOT NULL DEFAULT now(),
    attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
    max_attempts               integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
    lease_owner                uuid,
    lease_token                uuid,
    lease_expires_at           timestamptz,
    execution_receipt          jsonb NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(execution_receipt) = 'object'),
    last_error_code            text CHECK (
                                   last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
                               ),
    failure_code               text CHECK (
                                   failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
                               ),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    completed_at               timestamptz,

    CONSTRAINT inbox_reality_dispatch_commands_test_identity_fk
        FOREIGN KEY (
            tenant_id, test_id, campaign_id, content_revision_id, send_plan_id, artifact_id
        ) REFERENCES inbox_reality_tests (
            tenant_id, id, campaign_id, content_revision_id, send_plan_id, artifact_id
        ) ON DELETE CASCADE,
    CONSTRAINT inbox_reality_dispatch_commands_lease_shape_check CHECK (
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
             AND lease_expires_at IS NOT NULL)
        OR
        (state <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL
             AND lease_expires_at IS NULL)
    ),
    CONSTRAINT inbox_reality_dispatch_commands_terminal_shape_check CHECK (
        (state IN ('dispatched', 'failed', 'expired', 'cancelled') AND completed_at IS NOT NULL)
        OR
        (state NOT IN ('dispatched', 'failed', 'expired', 'cancelled') AND completed_at IS NULL)
    ),
    CONSTRAINT inbox_reality_dispatch_commands_failure_shape_check CHECK (
        (state = 'failed' AND failure_code IS NOT NULL)
        OR (state <> 'failed' AND failure_code IS NULL)
    ),
    CONSTRAINT inbox_reality_dispatch_commands_receipt_shape_check CHECK (
        (state = 'dispatched' AND execution_receipt <> '{}'::jsonb)
        OR state <> 'dispatched'
    ),
    CONSTRAINT inbox_reality_dispatch_commands_time_check CHECK (
        available_at >= created_at
        AND updated_at >= created_at
        AND (lease_expires_at IS NULL OR lease_expires_at > updated_at)
        AND (completed_at IS NULL OR completed_at >= created_at)
    ),
    UNIQUE (tenant_id, test_id),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (tenant_id, id)
);

CREATE INDEX inbox_reality_dispatch_commands_claimable_idx
    ON inbox_reality_dispatch_commands (available_at, created_at, id)
    WHERE state IN ('queued', 'retry_wait', 'leased');
CREATE INDEX inbox_reality_dispatch_commands_tenant_history_idx
    ON inbox_reality_dispatch_commands (tenant_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION inbox_reality_dispatch_command_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.test_id IS DISTINCT FROM OLD.test_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.content_revision_id IS DISTINCT FROM OLD.content_revision_id
       OR NEW.send_plan_id IS DISTINCT FROM OLD.send_plan_id
       OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
       OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
       OR NEW.artifact_mime_object_ref IS DISTINCT FROM OLD.artifact_mime_object_ref
       OR NEW.artifact_mime_hash IS DISTINCT FROM OLD.artifact_mime_hash
       OR NEW.artifact_structure_hash IS DISTINCT FROM OLD.artifact_structure_hash
       OR NEW.requested_capabilities IS DISTINCT FROM OLD.requested_capabilities
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Inbox Reality dispatch command identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('dispatched', 'failed', 'expired', 'cancelled')
       AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal Inbox Reality dispatch command is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state IN ('queued', 'retry_wait') AND NEW.state IN (
            'leased', 'failed', 'expired', 'cancelled'
        ))
        OR (OLD.state = 'leased' AND NEW.state IN (
            'retry_wait', 'dispatched', 'failed', 'expired', 'cancelled'
        ))
    ) THEN
        RAISE EXCEPTION 'invalid Inbox Reality command transition: % -> %', OLD.state, NEW.state
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER inbox_reality_dispatch_command_guard
    BEFORE UPDATE ON inbox_reality_dispatch_commands
    FOR EACH ROW EXECUTE FUNCTION inbox_reality_dispatch_command_guard();

-- Validate the object reference and hashes against the immutable artifact at
-- INSERT time. The application must present an exact bundle; the database does
-- not repair partial identity on its behalf.
CREATE OR REPLACE FUNCTION inbox_reality_dispatch_command_validate_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    artifact_row record;
BEGIN
    SELECT a.campaign_id, p.content_revision_id, a.send_plan_id, a.scenario_id,
           a.mime_object_ref, a.outbound_mime_hash, a.mime_structure_hash,
           a.expires_at, p.state AS plan_state, t.expires_at AS test_expires_at
      INTO STRICT artifact_row
      FROM public.campaign_render_artifacts a
      JOIN public.campaign_send_plans p
        ON p.tenant_id = a.tenant_id AND p.id = a.send_plan_id
      JOIN public.inbox_reality_tests t
        ON t.tenant_id = NEW.tenant_id AND t.id = NEW.test_id
     WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.artifact_id;

    IF NEW.campaign_id IS DISTINCT FROM artifact_row.campaign_id
       OR NEW.content_revision_id IS DISTINCT FROM artifact_row.content_revision_id
       OR NEW.send_plan_id IS DISTINCT FROM artifact_row.send_plan_id
       OR NEW.scenario_id IS DISTINCT FROM artifact_row.scenario_id
       OR NEW.artifact_mime_object_ref IS DISTINCT FROM artifact_row.mime_object_ref
       OR NEW.artifact_mime_hash IS DISTINCT FROM artifact_row.outbound_mime_hash
       OR NEW.artifact_structure_hash IS DISTINCT FROM artifact_row.mime_structure_hash
       OR artifact_row.plan_state NOT IN ('ready', 'certified')
       OR artifact_row.mime_object_ref IS NULL
       OR (artifact_row.expires_at IS NOT NULL
           AND artifact_row.expires_at <= artifact_row.test_expires_at) THEN
        RAISE EXCEPTION 'Inbox Reality dispatch command does not match a dispatchable artifact'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER inbox_reality_dispatch_command_validate_artifact
    BEFORE INSERT ON inbox_reality_dispatch_commands
    FOR EACH ROW EXECUTE FUNCTION inbox_reality_dispatch_command_validate_artifact();

-- The deliverability service owns one durable, non-address-bearing provider
-- attempt per controlled seed. A row found in dispatching after a crash is
-- indeterminate; it is never silently reclaimed and sent twice.
CREATE TABLE inbox_reality_seed_dispatches (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    test_id                    uuid NOT NULL,
    command_id                 uuid NOT NULL,
    mailbox_id                 text NOT NULL CHECK (length(mailbox_id) BETWEEN 1 AND 200),
    provider                   text NOT NULL CHECK (provider IN (
                                   'gmail', 'outlook_com', 'o365', 'icloud',
                                   'yahoo', 'proton', 'gmx', 'mailru'
                               )),
    capability_snapshot        jsonb NOT NULL CHECK (jsonb_typeof(capability_snapshot) = 'object'),
    artifact_mime_hash         text NOT NULL CHECK (artifact_mime_hash ~ '^[0-9a-f]{64}$'),
    dispatched_mime_hash       text NOT NULL CHECK (dispatched_mime_hash ~ '^[0-9a-f]{64}$'),
    state                      text NOT NULL DEFAULT 'prepared' CHECK (state IN (
                                   'prepared', 'dispatching', 'retry_wait', 'accepted',
                                   'rejected', 'indeterminate', 'expired', 'cancelled'
                               )),
    attempt_count              integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
    max_attempts               integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    available_at               timestamptz NOT NULL DEFAULT now(),
    dispatch_token             uuid,
    dispatch_started_at        timestamptz,
    provider_message_id_sha256 text CHECK (
                                   provider_message_id_sha256 IS NULL
                                   OR provider_message_id_sha256 ~ '^[0-9a-f]{64}$'
                               ),
    failure_code               text CHECK (
                                   failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
                               ),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    completed_at               timestamptz,

    CONSTRAINT inbox_reality_seed_dispatches_command_fk
        FOREIGN KEY (tenant_id, command_id)
        REFERENCES inbox_reality_dispatch_commands (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT inbox_reality_seed_dispatches_dispatch_shape_check CHECK (
        (state = 'dispatching' AND dispatch_token IS NOT NULL
            AND dispatch_started_at IS NOT NULL)
        OR
        (state <> 'dispatching' AND dispatch_token IS NULL)
    ),
    CONSTRAINT inbox_reality_seed_dispatches_terminal_shape_check CHECK (
        (state IN ('accepted', 'rejected', 'indeterminate', 'expired', 'cancelled')
            AND completed_at IS NOT NULL)
        OR
        (state NOT IN ('accepted', 'rejected', 'indeterminate', 'expired', 'cancelled')
            AND completed_at IS NULL)
    ),
    CONSTRAINT inbox_reality_seed_dispatches_receipt_shape_check CHECK (
        (state = 'accepted' AND provider_message_id_sha256 IS NOT NULL)
        OR (state <> 'accepted' AND provider_message_id_sha256 IS NULL)
    ),
    CONSTRAINT inbox_reality_seed_dispatches_time_check CHECK (
        available_at >= created_at
        AND updated_at >= created_at
        AND (dispatch_started_at IS NULL OR dispatch_started_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= created_at)
    ),
    UNIQUE (tenant_id, test_id, mailbox_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX inbox_reality_seed_dispatches_test_idx
    ON inbox_reality_seed_dispatches (tenant_id, test_id, provider, mailbox_id);
CREATE INDEX inbox_reality_seed_dispatches_recovery_idx
    ON inbox_reality_seed_dispatches (dispatch_started_at, id)
    WHERE state = 'dispatching';

CREATE OR REPLACE FUNCTION inbox_reality_seed_dispatch_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.test_id IS DISTINCT FROM OLD.test_id
       OR NEW.command_id IS DISTINCT FROM OLD.command_id
       OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.capability_snapshot IS DISTINCT FROM OLD.capability_snapshot
       OR NEW.artifact_mime_hash IS DISTINCT FROM OLD.artifact_mime_hash
       OR NEW.dispatched_mime_hash IS DISTINCT FROM OLD.dispatched_mime_hash
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Inbox Reality seed dispatch identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('accepted', 'rejected', 'indeterminate', 'expired', 'cancelled')
       AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal Inbox Reality seed dispatch is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state IN ('prepared', 'retry_wait') AND NEW.state IN (
            'dispatching', 'rejected', 'expired', 'cancelled'
        ))
        OR (OLD.state = 'dispatching' AND NEW.state IN (
            'retry_wait', 'accepted', 'rejected', 'indeterminate'
        ))
    ) THEN
        RAISE EXCEPTION 'invalid Inbox Reality seed dispatch transition: % -> %', OLD.state, NEW.state
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER inbox_reality_seed_dispatch_guard
    BEFORE UPDATE ON inbox_reality_seed_dispatches
    FOR EACH ROW EXECUTE FUNCTION inbox_reality_seed_dispatch_guard();

-- The legacy result table remains the bounded customer-facing latest-value
-- projection. The append-only seed_message_observations table is the evidence
-- ledger; these columns make callback replays exact and expose only sanitized
-- controlled-seed provenance.
ALTER TABLE inbox_reality_test_results
    ADD COLUMN IF NOT EXISTS observation_key text,
    ADD COLUMN IF NOT EXISTS artifact_id uuid,
    ADD COLUMN IF NOT EXISTS scenario_id text,
    ADD COLUMN IF NOT EXISTS capability_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS raw_mime_status text,
    ADD COLUMN IF NOT EXISTS received_mime_sha256 text,
    ADD COLUMN IF NOT EXISTS received_mime_structure_hash text,
    ADD COLUMN IF NOT EXISTS structure_comparison text,
    ADD COLUMN IF NOT EXISTS observation_captured_at timestamptz;

ALTER TABLE inbox_reality_test_results
    ADD CONSTRAINT inbox_reality_test_results_artifact_fk
        FOREIGN KEY (artifact_id) REFERENCES campaign_render_artifacts(id),
    ADD CONSTRAINT inbox_reality_test_results_capability_object_check
        CHECK (jsonb_typeof(capability_snapshot) = 'object'),
    ADD CONSTRAINT inbox_reality_test_results_observation_shape_check CHECK (
        (
            observation_key IS NULL AND artifact_id IS NULL AND scenario_id IS NULL
            AND raw_mime_status IS NULL AND received_mime_sha256 IS NULL
            AND received_mime_structure_hash IS NULL AND structure_comparison IS NULL
            AND observation_captured_at IS NULL
        )
        OR
        (
            observation_key ~ '^[0-9a-f]{64}$' AND artifact_id IS NOT NULL
            AND length(scenario_id) BETWEEN 1 AND 200
            AND raw_mime_status IN ('complete', 'truncated', 'failed', 'unavailable')
            AND (received_mime_sha256 IS NULL OR received_mime_sha256 ~ '^[0-9a-f]{64}$')
            AND (received_mime_structure_hash IS NULL OR received_mime_structure_hash ~ '^[0-9a-f]{64}$')
            AND ((raw_mime_status IN ('complete', 'truncated')) = (received_mime_sha256 IS NOT NULL))
            AND (structure_comparison = 'unavailable' OR received_mime_structure_hash IS NOT NULL)
            AND structure_comparison IN ('match', 'mismatch', 'unavailable')
            AND observation_captured_at IS NOT NULL
        )
    );

CREATE UNIQUE INDEX inbox_reality_test_results_observation_key_uidx
    ON inbox_reality_test_results (test_id, observation_key)
    WHERE observation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION inbox_reality_result_validate_observation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    test_row record;
BEGIN
    IF NEW.observation_key IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT artifact_id, scenario_id, expires_at
      INTO STRICT test_row
      FROM public.inbox_reality_tests
     WHERE id = NEW.test_id;
    IF NEW.artifact_id IS DISTINCT FROM test_row.artifact_id
       OR NEW.scenario_id IS DISTINCT FROM test_row.scenario_id
       OR NOT EXISTS (
           SELECT 1
             FROM public.inbox_reality_seed_dispatches d
            WHERE d.test_id = NEW.test_id
              AND d.mailbox_id = NEW.mailbox_id
              AND d.provider = NEW.provider
              AND d.state IN ('accepted', 'indeterminate')
       )
       OR NEW.observation_captured_at > clock_timestamp() + interval '5 minutes' THEN
        RAISE EXCEPTION 'Inbox Reality result does not match gateway test identity'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER inbox_reality_result_validate_observation
    BEFORE INSERT OR UPDATE ON inbox_reality_test_results
    FOR EACH ROW EXECUTE FUNCTION inbox_reality_result_validate_observation();

-- Status is a monotonic lifecycle. Identity immutability is enforced by 1927;
-- this trigger prevents a terminal row from being reopened by a stale callback.
CREATE OR REPLACE FUNCTION inbox_reality_test_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'awaiting_delivery' AND NEW.status IN (
            'classifying', 'complete', 'expired', 'cancelled'
        ))
        OR (OLD.status = 'classifying' AND NEW.status IN (
            'complete', 'cancelled'
        ))
    ) THEN
        RAISE EXCEPTION 'invalid Inbox Reality test transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;
    IF OLD.status IN ('complete', 'expired', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal Inbox Reality test is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER inbox_reality_test_status_guard
    BEFORE UPDATE ON inbox_reality_tests
    FOR EACH ROW EXECUTE FUNCTION inbox_reality_test_status_guard();

COMMENT ON TABLE inbox_reality_dispatch_commands IS
    'Gateway-owned durable exact-artifact commands for controlled Inbox Reality execution.';
COMMENT ON TABLE inbox_reality_seed_dispatches IS
    'Deliverability-owned, address-free provider dispatch receipts for controlled seed mailboxes.';
COMMENT ON COLUMN inbox_reality_seed_dispatches.dispatched_mime_hash IS
    'SHA-256 after deterministic X-Postwave-Test-ID insertion; artifact_mime_hash remains the source object identity.';

GRANT SELECT, INSERT, UPDATE ON inbox_reality_dispatch_commands TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON inbox_reality_seed_dispatches TO postwave_app;
REVOKE DELETE, TRUNCATE ON inbox_reality_dispatch_commands FROM postwave_app;
REVOKE DELETE, TRUNCATE ON inbox_reality_seed_dispatches FROM postwave_app;

ALTER TABLE inbox_reality_dispatch_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_reality_dispatch_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox_reality_seed_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_reality_seed_dispatches FORCE ROW LEVEL SECURITY;

-- Cross-tenant workers need to inspect the parent lifecycle rows while
-- claiming commands and validating service execution requests. These grants
-- remain two-factor: both the generic worker flag and the purpose-specific
-- flag must be transaction-local true.
CREATE POLICY inbox_reality_tests_dispatch_worker_select
    ON inbox_reality_tests FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND (
            current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
            OR current_setting('app.inbox_reality_execution_worker', true) = 'true'
        )
    );
CREATE POLICY inbox_reality_tests_dispatch_worker_update
    ON inbox_reality_tests FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
    );
CREATE POLICY inbox_reality_results_dispatch_worker_select
    ON inbox_reality_test_results FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
    );

CREATE POLICY inbox_reality_dispatch_commands_tenant_select
    ON inbox_reality_dispatch_commands FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inbox_reality_dispatch_commands_tenant_insert
    ON inbox_reality_dispatch_commands FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inbox_reality_dispatch_commands_tenant_update
    ON inbox_reality_dispatch_commands FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inbox_reality_dispatch_commands_worker_select
    ON inbox_reality_dispatch_commands FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
    );
CREATE POLICY inbox_reality_dispatch_commands_worker_update
    ON inbox_reality_dispatch_commands FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_dispatch_worker', true) = 'true'
    );

CREATE POLICY inbox_reality_seed_dispatches_tenant_select
    ON inbox_reality_seed_dispatches FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inbox_reality_seed_dispatches_tenant_update
    ON inbox_reality_seed_dispatches FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inbox_reality_seed_dispatches_worker_select
    ON inbox_reality_seed_dispatches FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_execution_worker', true) = 'true'
    );
CREATE POLICY inbox_reality_seed_dispatches_worker_insert
    ON inbox_reality_seed_dispatches FOR INSERT TO postwave_app
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_execution_worker', true) = 'true'
    );
CREATE POLICY inbox_reality_seed_dispatches_worker_update
    ON inbox_reality_seed_dispatches FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_execution_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.inbox_reality_execution_worker', true) = 'true'
    );

COMMIT;
