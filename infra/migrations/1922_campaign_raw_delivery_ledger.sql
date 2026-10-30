-- 1922_campaign_raw_delivery_ledger.sql
--
-- Exact-byte campaign delivery receipts. The ledger binds a real-recipient
-- attempt to one frozen plan/scenario, the completed assurance receipt that
-- permitted it, and the outbound MIME hash. It deliberately stores neither
-- the recipient address nor the real-recipient MIME body.
--
-- SES raw delivery has no provider idempotency token. The state machine thus
-- never reclaims `dispatching`: an expired or ambiguous provider call becomes
-- `indeterminate` and requires provider-event reconciliation or a governed
-- operator decision. Replaying an accepted application idempotency key returns
-- its receipt without a second provider call.
--
-- rollback-strategy: no-op. Delivery evidence may already be referenced by
-- feedback, reply, audit, and customer receipts and must survive rollbacks.

BEGIN;

-- Full copied identity makes a delivery FK prove the exact completed
-- assurance receipt rather than merely pointing at a run UUID.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_assurance_runs_delivery_identity_uidx
    ON campaign_assurance_runs (
        tenant_id, campaign_id, id, send_plan_id, attempt_count,
        artifact_set_hash, source_hash, plan_hash
    );

-- The send queue's bigint key is globally unique, but the composite identity
-- proves campaign and tenant ownership inside the delivery row.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_delivery_identity_uidx
    ON campaign_recipients (tenant_id, campaign_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_assurance_run_artifacts_delivery_identity_uidx
    ON campaign_assurance_run_artifacts (
        tenant_id, campaign_id, run_id, send_plan_id, artifact_id, scenario_id
    );

-- Governance decisions are append-only. Queue/delivery authorization reads
-- the newest exact finding decision so a later `reject` revokes an earlier
-- `allow_send` instead of leaving a permanently reusable waiver.
CREATE INDEX IF NOT EXISTS campaign_assurance_overrides_latest_decision_idx
    ON campaign_assurance_overrides (
        tenant_id, campaign_id, run_id, attempt_count, finding_id,
        artifact_set_hash, created_at DESC, id DESC
    );

CREATE TABLE campaign_send_deliveries (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id                uuid NOT NULL,
    campaign_recipient_id      bigint NOT NULL,
    send_plan_id               uuid NOT NULL,
    artifact_id                uuid NOT NULL,
    assurance_run_id           uuid NOT NULL,
    assurance_attempt_count    integer NOT NULL CHECK (assurance_attempt_count >= 1),
    artifact_set_hash          text NOT NULL CHECK (artifact_set_hash ~ '^[0-9a-f]{64}$'),
    gate_decision              text NOT NULL CHECK (gate_decision IN (
                                   'pass', 'warn', 'overridden'
                               )),
    gate_override_id           uuid,
    scenario_id                text NOT NULL CHECK (length(scenario_id) BETWEEN 1 AND 200),
    source_hash                text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    plan_hash                  text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
    compiler_version           text NOT NULL CHECK (length(compiler_version) BETWEEN 1 AND 160),
    outbound_mime_hash         text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    message_id                 text NOT NULL CHECK (
                                   length(message_id) BETWEEN 3 AND 998
                                   AND position(E'\n' in message_id) = 0
                                   AND position(E'\r' in message_id) = 0
                               ),
    attempt_no                 integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 100),
    idempotency_key            text NOT NULL CHECK (
                                   length(idempotency_key) BETWEEN 1 AND 255
                                   AND position(E'\n' in idempotency_key) = 0
                                   AND position(E'\r' in idempotency_key) = 0
                               ),
    request_hash               text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    transport_name             text NOT NULL CHECK (
                                   transport_name ~ '^[a-z][a-z0-9_.-]{0,95}$'
                               ),
    transport_contract_version text NOT NULL CHECK (
                                   length(transport_contract_version) BETWEEN 1 AND 160
                               ),
    capability_snapshot        jsonb NOT NULL CHECK (
                                   jsonb_typeof(capability_snapshot) = 'object'
                                   AND octet_length(capability_snapshot::text) <= 16384
                               ),
    state                      text NOT NULL DEFAULT 'prepared' CHECK (state IN (
                                   'prepared', 'dispatching', 'accepted',
                                   'rejected', 'indeterminate'
                               )),
    claim_token                uuid NOT NULL,
    lease_owner                text,
    lease_expires_at           timestamptz,
    dispatch_started_at        timestamptz,
    provider_message_id        text CHECK (
                                   provider_message_id IS NULL OR
                                   length(provider_message_id) BETWEEN 1 AND 512
                               ),
    receipt_hash               text CHECK (
                                   receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$'
                               ),
    idempotency_mode           text CHECK (
                                   idempotency_mode IS NULL OR
                                   length(idempotency_mode) BETWEEN 1 AND 160
                               ),
    failure_disposition        text CHECK (
                                   failure_disposition IS NULL OR
                                   failure_disposition IN (
                                       'definitely_not_sent', 'indeterminate'
                                   )
                               ),
    failure_code               text CHECK (
                                   failure_code IS NULL OR
                                   failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
                               ),
    provider_reconciled_at     timestamptz,
    reconciliation_source     text CHECK (
                                   reconciliation_source IS NULL OR
                                   reconciliation_source ~ '^[a-z][a-z0-9_.-]{0,95}$'
                               ),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    accepted_at                timestamptz,
    rejected_at                timestamptz,
    indeterminate_at           timestamptz,
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_send_deliveries_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_send_deliveries_recipient_fk
        FOREIGN KEY (tenant_id, campaign_id, campaign_recipient_id)
        REFERENCES campaign_recipients (tenant_id, campaign_id, id),
    CONSTRAINT campaign_send_deliveries_assurance_identity_fk
        FOREIGN KEY (
            tenant_id, campaign_id, assurance_run_id, send_plan_id,
            assurance_attempt_count, artifact_set_hash, source_hash, plan_hash
        )
        REFERENCES campaign_assurance_runs (
            tenant_id, campaign_id, id, send_plan_id, attempt_count,
            artifact_set_hash, source_hash, plan_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_send_deliveries_run_artifact_fk
        FOREIGN KEY (
            tenant_id, campaign_id, assurance_run_id, send_plan_id, artifact_id,
            scenario_id
        )
        REFERENCES campaign_assurance_run_artifacts (
            tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
            scenario_id
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_send_deliveries_override_fk
        FOREIGN KEY (tenant_id, gate_override_id)
        REFERENCES campaign_assurance_overrides (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_send_deliveries_gate_shape_check CHECK (
        (gate_decision IN ('pass', 'warn') AND gate_override_id IS NULL)
        OR (gate_decision = 'overridden' AND gate_override_id IS NOT NULL)
    ),
    CONSTRAINT campaign_send_deliveries_timestamp_order_check CHECK (
        (lease_expires_at IS NULL OR lease_expires_at > created_at)
        AND (dispatch_started_at IS NULL OR dispatch_started_at >= created_at)
        AND (accepted_at IS NULL OR accepted_at >= dispatch_started_at)
        AND (rejected_at IS NULL OR rejected_at >= dispatch_started_at)
        AND (indeterminate_at IS NULL OR indeterminate_at >= dispatch_started_at)
        AND (provider_reconciled_at IS NULL OR
             provider_reconciled_at >= indeterminate_at)
    ),
    CONSTRAINT campaign_send_deliveries_state_shape_check CHECK (
        (state = 'prepared'
            AND lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 200
            AND lease_expires_at IS NOT NULL
            AND dispatch_started_at IS NULL
            AND provider_message_id IS NULL AND receipt_hash IS NULL
            AND idempotency_mode IS NULL
            AND failure_disposition IS NULL AND failure_code IS NULL
            AND accepted_at IS NULL AND rejected_at IS NULL
            AND indeterminate_at IS NULL AND provider_reconciled_at IS NULL
            AND reconciliation_source IS NULL)
        OR
        (state = 'dispatching'
            AND lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 200
            AND lease_expires_at IS NOT NULL
            AND dispatch_started_at IS NOT NULL
            AND provider_message_id IS NULL AND receipt_hash IS NULL
            AND idempotency_mode IS NULL
            AND failure_disposition IS NULL AND failure_code IS NULL
            AND accepted_at IS NULL AND rejected_at IS NULL
            AND indeterminate_at IS NULL AND provider_reconciled_at IS NULL
            AND reconciliation_source IS NULL)
        OR
        (state = 'accepted'
            AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND dispatch_started_at IS NOT NULL
            AND receipt_hash IS NOT NULL AND idempotency_mode IS NOT NULL
            AND failure_disposition IS NULL AND failure_code IS NULL
            AND accepted_at IS NOT NULL AND rejected_at IS NULL
            AND ((provider_reconciled_at IS NULL AND reconciliation_source IS NULL
                  AND indeterminate_at IS NULL)
                 OR (provider_reconciled_at IS NOT NULL AND reconciliation_source IS NOT NULL
                     AND indeterminate_at IS NOT NULL)))
        OR
        (state = 'rejected'
            AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND dispatch_started_at IS NOT NULL
            AND provider_message_id IS NULL AND receipt_hash IS NULL
            AND idempotency_mode IS NULL
            AND failure_disposition = 'definitely_not_sent'
            AND failure_code IS NOT NULL
            AND accepted_at IS NULL AND rejected_at IS NOT NULL
            AND ((provider_reconciled_at IS NULL AND reconciliation_source IS NULL
                  AND indeterminate_at IS NULL)
                 OR (provider_reconciled_at IS NOT NULL AND reconciliation_source IS NOT NULL
                     AND indeterminate_at IS NOT NULL)))
        OR
        (state = 'indeterminate'
            AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND dispatch_started_at IS NOT NULL
            AND receipt_hash IS NULL AND idempotency_mode IS NULL
            AND failure_disposition = 'indeterminate'
            AND failure_code IS NOT NULL
            AND accepted_at IS NULL AND rejected_at IS NULL
            AND indeterminate_at IS NOT NULL
            AND provider_reconciled_at IS NULL AND reconciliation_source IS NULL)
    ),
    UNIQUE (tenant_id, campaign_recipient_id, attempt_no),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (tenant_id, message_id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, campaign_id, id)
);

CREATE UNIQUE INDEX campaign_send_deliveries_one_nonretryable_recipient_uidx
    ON campaign_send_deliveries (tenant_id, campaign_recipient_id)
    WHERE state IN ('prepared', 'dispatching', 'indeterminate', 'accepted');

CREATE INDEX campaign_send_deliveries_campaign_created_idx
    ON campaign_send_deliveries (tenant_id, campaign_id, created_at DESC, id DESC);

CREATE INDEX campaign_send_deliveries_dispatch_lease_idx
    ON campaign_send_deliveries (tenant_id, lease_expires_at, id)
    WHERE state = 'dispatching';

CREATE UNIQUE INDEX campaign_send_deliveries_provider_message_uidx
    ON campaign_send_deliveries (transport_name, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- Append-only transition receipts are generated by the database so a caller
-- cannot update current state without leaving history.
CREATE TABLE campaign_send_delivery_events (
    tenant_id              uuid NOT NULL,
    campaign_id            uuid NOT NULL,
    delivery_id            uuid NOT NULL,
    event_no               integer NOT NULL CHECK (event_no > 0),
    from_state             text,
    to_state               text NOT NULL CHECK (to_state IN (
                               'prepared', 'dispatching', 'accepted',
                               'rejected', 'indeterminate'
                           )),
    claim_token            uuid NOT NULL,
    provider_message_id    text,
    receipt_hash           text,
    failure_disposition    text,
    failure_code           text,
    event_source           text NOT NULL CHECK (
                               event_source ~ '^[a-z][a-z0-9_.-]{0,95}$'
                           ),
    occurred_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, delivery_id, event_no),
    CONSTRAINT campaign_send_delivery_events_delivery_fk
        FOREIGN KEY (tenant_id, campaign_id, delivery_id)
        REFERENCES campaign_send_deliveries (tenant_id, campaign_id, id)
        ON DELETE CASCADE
);

CREATE INDEX campaign_send_delivery_events_campaign_idx
    ON campaign_send_delivery_events (
        tenant_id, campaign_id, occurred_at DESC, delivery_id, event_no
    );

-- Validate the completed gate at first insertion. Later staleness never
-- rewrites the historical decision used at send time.
CREATE OR REPLACE FUNCTION campaign_send_deliveries_gate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    run_state text;
    run_gate text;
    override_decision text;
    override_expires_at timestamptz;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RETURN NEW;
    END IF;

    SELECT state, gate_decision
      INTO run_state, run_gate
      FROM public.campaign_assurance_runs
     WHERE tenant_id = NEW.tenant_id
       AND campaign_id = NEW.campaign_id
       AND id = NEW.assurance_run_id
       AND attempt_count = NEW.assurance_attempt_count
       AND artifact_set_hash = NEW.artifact_set_hash
     FOR SHARE;

    IF NOT FOUND OR run_state <> 'complete' THEN
        RAISE EXCEPTION 'raw delivery requires a completed assurance run'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.gate_decision IN ('pass', 'warn') THEN
        IF run_gate <> NEW.gate_decision OR NEW.gate_override_id IS NOT NULL THEN
            RAISE EXCEPTION 'delivery gate decision does not match assurance receipt'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.gate_decision = 'overridden' THEN
        IF run_gate <> 'block' OR NEW.gate_override_id IS NULL THEN
            RAISE EXCEPTION 'only a blocked run can be overridden for delivery'
                USING ERRCODE = '23514';
        END IF;
        SELECT selected.decision, selected.expires_at
          INTO override_decision, override_expires_at
          FROM public.campaign_assurance_overrides AS selected
         WHERE selected.tenant_id = NEW.tenant_id
           AND selected.campaign_id = NEW.campaign_id
           AND selected.run_id = NEW.assurance_run_id
           AND selected.attempt_count = NEW.assurance_attempt_count
           AND selected.artifact_set_hash = NEW.artifact_set_hash
           AND selected.id = NEW.gate_override_id
           AND selected.id = (
               SELECT latest.id
                 FROM public.campaign_assurance_overrides AS latest
                WHERE latest.tenant_id = selected.tenant_id
                  AND latest.campaign_id = selected.campaign_id
                  AND latest.run_id = selected.run_id
                  AND latest.attempt_count = selected.attempt_count
                  AND latest.artifact_set_hash = selected.artifact_set_hash
                  AND latest.finding_id = selected.finding_id
                ORDER BY latest.created_at DESC, latest.id DESC
                LIMIT 1
           );
        IF NOT FOUND OR override_decision <> 'allow_send' OR
           (override_expires_at IS NOT NULL AND override_expires_at <= statement_timestamp()) THEN
            RAISE EXCEPTION 'delivery override is missing, expired, or does not allow send'
                USING ERRCODE = '23514';
        END IF;

        -- Overrides are finding-scoped. A receipt for one finding must not
        -- silently waive a different blocker (especially a non-overridable
        -- deterministic failure). Every blocker in the exact terminal
        -- attempt must have its own live allow-send governance receipt.
        IF EXISTS (
            SELECT 1
              FROM public.campaign_assurance_findings AS findings
             WHERE findings.tenant_id = NEW.tenant_id
               AND findings.campaign_id = NEW.campaign_id
               AND findings.run_id = NEW.assurance_run_id
               AND findings.attempt_count = NEW.assurance_attempt_count
               AND findings.blocking
               AND NOT EXISTS (
                   SELECT 1
                     FROM public.campaign_assurance_overrides AS latest_decision
                    WHERE latest_decision.tenant_id = findings.tenant_id
                      AND latest_decision.campaign_id = findings.campaign_id
                      AND latest_decision.run_id = findings.run_id
                      AND latest_decision.attempt_count = findings.attempt_count
                      AND latest_decision.artifact_set_hash = NEW.artifact_set_hash
                      AND latest_decision.finding_id = findings.id
                      AND latest_decision.finding_receipt_hash = findings.receipt_hash
                      AND latest_decision.id = (
                          SELECT candidate.id
                            FROM public.campaign_assurance_overrides AS candidate
                           WHERE candidate.tenant_id = findings.tenant_id
                             AND candidate.campaign_id = findings.campaign_id
                             AND candidate.run_id = findings.run_id
                             AND candidate.attempt_count = findings.attempt_count
                             AND candidate.artifact_set_hash = NEW.artifact_set_hash
                             AND candidate.finding_id = findings.id
                           ORDER BY candidate.created_at DESC, candidate.id DESC
                           LIMIT 1
                      )
                      AND latest_decision.decision = 'allow_send'
                      AND (
                          latest_decision.expires_at IS NULL OR
                          latest_decision.expires_at > statement_timestamp()
                      )
               )
        ) THEN
            RAISE EXCEPTION 'every blocking finding requires a live allow-send override'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'unsupported delivery gate decision'
        USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER campaign_send_deliveries_gate_guard
    BEFORE INSERT ON campaign_send_deliveries
    FOR EACH ROW EXECUTE FUNCTION campaign_send_deliveries_gate_guard();

CREATE OR REPLACE FUNCTION campaign_send_deliveries_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    immutable_columns text[] := ARRAY[
        'id', 'tenant_id', 'campaign_id', 'campaign_recipient_id',
        'send_plan_id', 'artifact_id', 'assurance_run_id',
        'assurance_attempt_count', 'artifact_set_hash', 'gate_decision',
        'gate_override_id', 'scenario_id', 'source_hash', 'plan_hash',
        'compiler_version', 'outbound_mime_hash', 'message_id', 'attempt_no',
        'idempotency_key', 'request_hash', 'transport_name',
        'transport_contract_version', 'capability_snapshot', 'created_at'
    ];
    column_name text;
BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') AND
       current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'raw delivery mutation requires tenant-bound worker scope'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.campaigns
             WHERE tenant_id = OLD.tenant_id AND id = OLD.campaign_id
        ) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'campaign send delivery evidence is append-only'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'prepared' THEN
            RAISE EXCEPTION 'campaign send delivery must start prepared'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    FOREACH column_name IN ARRAY immutable_columns LOOP
        IF (to_jsonb(NEW)->column_name) IS DISTINCT FROM (to_jsonb(OLD)->column_name) THEN
            RAISE EXCEPTION 'campaign send delivery identity is immutable: %', column_name
                USING ERRCODE = '55000';
        END IF;
    END LOOP;

    IF NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'campaign send delivery updated_at must increase'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.state = 'prepared' AND NEW.state = 'prepared' THEN
        IF OLD.lease_expires_at > statement_timestamp() THEN
            RAISE EXCEPTION 'active prepared delivery lease cannot be reclaimed'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.claim_token = OLD.claim_token OR
           NEW.lease_expires_at <= statement_timestamp() OR
           NEW IS DISTINCT FROM jsonb_populate_record(
               OLD,
               jsonb_build_object(
                   'claim_token', NEW.claim_token,
                   'lease_owner', NEW.lease_owner,
                   'lease_expires_at', NEW.lease_expires_at,
                   'updated_at', NEW.updated_at
               )
           ) THEN
            RAISE EXCEPTION 'invalid prepared delivery lease reclaim'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'prepared' AND NEW.state = 'dispatching' THEN
        IF NEW.claim_token <> OLD.claim_token OR
           OLD.lease_expires_at <= statement_timestamp() OR
           NEW.dispatch_started_at IS NULL OR
           NEW IS DISTINCT FROM jsonb_populate_record(
               OLD,
               jsonb_build_object(
                   'state', 'dispatching',
                   'dispatch_started_at', NEW.dispatch_started_at,
                   'updated_at', NEW.updated_at
               )
           ) THEN
            RAISE EXCEPTION 'invalid prepared to dispatching transition'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'dispatching' AND NEW.state IN ('accepted', 'rejected', 'indeterminate') THEN
        IF NEW.claim_token <> OLD.claim_token OR
           NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
            RAISE EXCEPTION 'invalid fenced delivery completion'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.state = 'accepted' AND NEW IS DISTINCT FROM jsonb_populate_record(
            OLD,
            jsonb_build_object(
                'state', 'accepted',
                'lease_owner', NULL,
                'lease_expires_at', NULL,
                'provider_message_id', NEW.provider_message_id,
                'receipt_hash', NEW.receipt_hash,
                'idempotency_mode', NEW.idempotency_mode,
                'accepted_at', NEW.accepted_at,
                'updated_at', NEW.updated_at
            )
        ) THEN
            RAISE EXCEPTION 'accepted delivery changed non-receipt fields'
                USING ERRCODE = '55000';
        ELSIF NEW.state = 'rejected' AND NEW IS DISTINCT FROM jsonb_populate_record(
            OLD,
            jsonb_build_object(
                'state', 'rejected',
                'lease_owner', NULL,
                'lease_expires_at', NULL,
                'failure_disposition', NEW.failure_disposition,
                'failure_code', NEW.failure_code,
                'rejected_at', NEW.rejected_at,
                'updated_at', NEW.updated_at
            )
        ) THEN
            RAISE EXCEPTION 'rejected delivery changed non-failure fields'
                USING ERRCODE = '55000';
        ELSIF NEW.state = 'indeterminate' AND NEW IS DISTINCT FROM jsonb_populate_record(
            OLD,
            jsonb_build_object(
                'state', 'indeterminate',
                'lease_owner', NULL,
                'lease_expires_at', NULL,
                'provider_message_id', NEW.provider_message_id,
                'failure_disposition', NEW.failure_disposition,
                'failure_code', NEW.failure_code,
                'indeterminate_at', NEW.indeterminate_at,
                'updated_at', NEW.updated_at
            )
        ) THEN
            RAISE EXCEPTION 'indeterminate delivery changed non-evidence fields'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'indeterminate' AND NEW.state IN ('accepted', 'rejected') THEN
        IF NEW.provider_reconciled_at IS NULL OR NEW.reconciliation_source IS NULL THEN
            RAISE EXCEPTION 'indeterminate delivery requires reconciliation evidence'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.state = 'accepted' AND NEW IS DISTINCT FROM jsonb_populate_record(
            OLD,
            jsonb_build_object(
                'state', 'accepted',
                'provider_message_id', NEW.provider_message_id,
                'receipt_hash', NEW.receipt_hash,
                'idempotency_mode', NEW.idempotency_mode,
                'failure_disposition', NULL,
                'failure_code', NULL,
                'accepted_at', NEW.accepted_at,
                'provider_reconciled_at', NEW.provider_reconciled_at,
                'reconciliation_source', NEW.reconciliation_source,
                'updated_at', NEW.updated_at
            )
        ) THEN
            RAISE EXCEPTION 'accepted reconciliation changed non-receipt fields'
                USING ERRCODE = '55000';
        ELSIF NEW.state = 'rejected' AND NEW IS DISTINCT FROM jsonb_populate_record(
            OLD,
            jsonb_build_object(
                'state', 'rejected',
                'provider_message_id', NULL,
                'failure_disposition', 'definitely_not_sent',
                'failure_code', NEW.failure_code,
                'rejected_at', NEW.rejected_at,
                'provider_reconciled_at', NEW.provider_reconciled_at,
                'reconciliation_source', NEW.reconciliation_source,
                'updated_at', NEW.updated_at
            )
        ) THEN
            RAISE EXCEPTION 'rejected reconciliation changed non-failure fields'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'invalid campaign send delivery transition: % -> %', OLD.state, NEW.state
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_send_deliveries_lifecycle_guard
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_send_deliveries
    FOR EACH ROW EXECUTE FUNCTION campaign_send_deliveries_lifecycle_guard();

CREATE OR REPLACE FUNCTION campaign_send_delivery_event_append()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    next_event_no integer;
    source_name text;
BEGIN
    SELECT COALESCE(max(event_no), 0) + 1
      INTO next_event_no
      FROM public.campaign_send_delivery_events
     WHERE tenant_id = NEW.tenant_id AND delivery_id = NEW.id;

    source_name := CASE
        WHEN NEW.provider_reconciled_at IS NOT NULL THEN NEW.reconciliation_source
        WHEN NEW.state = 'indeterminate' AND NEW.failure_code = 'DISPATCH_LEASE_EXPIRED'
            THEN 'lease_sweeper'
        ELSE 'delivery_coordinator'
    END;

    INSERT INTO public.campaign_send_delivery_events (
        tenant_id, campaign_id, delivery_id, event_no,
        from_state, to_state, claim_token, provider_message_id,
        receipt_hash, failure_disposition, failure_code, event_source
    ) VALUES (
        NEW.tenant_id, NEW.campaign_id, NEW.id, next_event_no,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.state ELSE NULL END,
        NEW.state, NEW.claim_token, NEW.provider_message_id,
        NEW.receipt_hash, NEW.failure_disposition, NEW.failure_code, source_name
    );
    RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_send_delivery_event_append() FROM PUBLIC;

CREATE TRIGGER campaign_send_delivery_event_append
    AFTER INSERT OR UPDATE ON campaign_send_deliveries
    FOR EACH ROW EXECUTE FUNCTION campaign_send_delivery_event_append();

CREATE OR REPLACE FUNCTION campaign_send_delivery_events_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.campaigns
         WHERE tenant_id = OLD.tenant_id AND id = OLD.campaign_id
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'campaign send delivery events are append-only'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_send_delivery_events_immutable
    BEFORE UPDATE OR DELETE ON campaign_send_delivery_events
    FOR EACH ROW EXECUTE FUNCTION campaign_send_delivery_events_immutable_guard();

ALTER TABLE campaign_send_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_send_deliveries_scope_boundary ON campaign_send_deliveries
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_send_deliveries_tenant_select ON campaign_send_deliveries
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_send_deliveries_worker_access ON campaign_send_deliveries
    FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

ALTER TABLE campaign_send_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_send_delivery_events_scope_boundary ON campaign_send_delivery_events
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_send_delivery_events_tenant_select ON campaign_send_delivery_events
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_send_delivery_events_worker_select ON campaign_send_delivery_events
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
-- The SECURITY DEFINER transition trigger still obeys FORCE RLS when its
-- owner is not a BYPASSRLS role. PUBLIC here grants no table privilege; it
-- only lets that trigger insert the already tenant-bound NEW row. Direct app
-- INSERT remains impossible because INSERT is revoked below.
CREATE POLICY campaign_send_delivery_events_trigger_insert ON campaign_send_delivery_events
    FOR INSERT TO PUBLIC
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

GRANT SELECT, INSERT, UPDATE ON campaign_send_deliveries TO postwave_app;
GRANT SELECT ON campaign_send_delivery_events TO postwave_app;
REVOKE DELETE, TRUNCATE ON campaign_send_deliveries FROM postwave_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON campaign_send_delivery_events FROM postwave_app;

COMMENT ON TABLE campaign_send_deliveries IS
    'Hash-only real-recipient raw-MIME send ledger with exact assurance provenance and no ambiguous automatic retry.';
COMMENT ON TABLE campaign_send_delivery_events IS
    'Database-generated append-only lifecycle receipts for raw campaign delivery attempts.';

COMMIT;
