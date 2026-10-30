-- 1790_inbound_webhook_action_outbox.sql
--
-- Inbound webhook acceptance used to commit inbound_events and then launch
-- detached goroutines for automation fanout and configured trigger actions.
-- A process crash in that gap permanently lost the actions, while a sender
-- retry hit inbound_events' replay key and deliberately skipped them.
--
-- This table is the durable, per-action continuation of an accepted inbound
-- event. The API inserts the event and all action snapshots in one tenant
-- transaction. Workers discover due tenants under app.outbox_worker, then
-- claim and mutate rows only after entering that tenant's RLS scope.

BEGIN;

CREATE TABLE IF NOT EXISTS inbound_webhook_replay_receipts (
    id                  uuid PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    inbound_event_id    bigint NOT NULL REFERENCES inbound_events(id) ON DELETE CASCADE,
    endpoint_id         uuid NOT NULL REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, inbound_event_id, id)
);

CREATE TABLE IF NOT EXISTS inbound_webhook_action_intents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    inbound_event_id    bigint NOT NULL REFERENCES inbound_events(id) ON DELETE CASCADE,
    endpoint_id         uuid NOT NULL REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE,
    -- NULL for the original receipt; non-NULL identifies one operator-requested
    -- replay. A replay intentionally creates a fresh semantic attempt.
    replay_id           uuid,
    intent_kind         text NOT NULL CHECK (intent_kind IN
                            ('automation_event', 'trigger_action')),
    -- Trigger fields are occurrence-time snapshots. There is deliberately no
    -- FK to inbound_webhook_triggers: deleting or editing a rule after receipt
    -- must not rewrite work that was already accepted.
    trigger_id          uuid,
    trigger_name        text,
    action_type         text,
    action_target_id    text,
    -- NULL is allowed only for an occurrence-time trigger match that could
    -- not resolve a usable email. That intent is inserted directly as failed
    -- so the misconfiguration remains observable without retaining junk PII.
    subscriber_email    text,
    state               text NOT NULL DEFAULT 'pending' CHECK (state IN
                            ('pending', 'leased', 'succeeded', 'failed')),
    attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    lease_token         uuid,
    lease_expires_at    timestamptz,
    last_error_code     text,
    last_http_status    smallint,
    completed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inbound_webhook_action_intent_shape CHECK (
        (
            intent_kind = 'automation_event'
            AND trigger_id IS NULL
            AND trigger_name IS NULL
            AND action_type IS NULL
            AND action_target_id IS NULL
        )
        OR
        (
            intent_kind = 'trigger_action'
            AND trigger_id IS NOT NULL
            AND action_type IN
                ('add_to_sequence', 'add_tag', 'remove_tag', 'start_automation')
            AND (
                NULLIF(btrim(action_target_id), '') IS NOT NULL
                OR state = 'failed'
            )
        )
    ),
    CONSTRAINT inbound_webhook_action_intent_bounds CHECK (
        (subscriber_email IS NULL OR octet_length(subscriber_email) BETWEEN 3 AND 320)
        AND (trigger_name IS NULL OR octet_length(trigger_name) <= 256)
        AND (action_target_id IS NULL OR octet_length(action_target_id) <= 512)
        AND (last_error_code IS NULL OR octet_length(last_error_code) <= 64)
        AND (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599)
    ),
    CONSTRAINT inbound_webhook_action_intent_lease_shape CHECK (
        (state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT inbound_webhook_action_intent_completion_shape CHECK (
        (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
        OR
        (state IN ('pending', 'leased') AND completed_at IS NULL)
    ),
    CONSTRAINT inbound_webhook_action_intent_recipient_shape CHECK (
        subscriber_email IS NOT NULL
        OR (intent_kind = 'trigger_action' AND state = 'failed')
    )
);

-- A provider retry must never mint a second action for the original receipt.
-- The all-zero UUID stands in for automation_event's NULL trigger_id.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_webhook_action_intents_original_uidx
    ON inbound_webhook_action_intents (
        tenant_id,
        inbound_event_id,
        intent_kind,
        COALESCE(trigger_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE replay_id IS NULL;

CREATE INDEX IF NOT EXISTS inbound_webhook_action_intents_due_idx
    ON inbound_webhook_action_intents (next_attempt_at, tenant_id, created_at, id)
    WHERE state IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS inbound_webhook_action_intents_event_idx
    ON inbound_webhook_action_intents (tenant_id, inbound_event_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_webhook_action_intents_replay_uidx
    ON inbound_webhook_action_intents (
        tenant_id,
        replay_id,
        intent_kind,
        COALESCE(trigger_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE replay_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE
    ON inbound_webhook_replay_receipts TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON inbound_webhook_action_intents TO postwave_app;

ALTER TABLE inbound_webhook_replay_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_webhook_replay_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE inbound_webhook_action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_webhook_action_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY inbound_webhook_replay_receipts_tenant
    ON inbound_webhook_replay_receipts
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY inbound_webhook_action_intents_boundary
    ON inbound_webhook_action_intents
    AS RESTRICTIVE
    FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY inbound_webhook_action_intents_tenant
    ON inbound_webhook_action_intents
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY inbound_webhook_action_intents_worker_discovery
    ON inbound_webhook_action_intents
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (
        COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
    );

-- Snapshot identity and action semantics are immutable after acceptance.
-- Workers may update only delivery lifecycle/diagnostic columns.
CREATE OR REPLACE FUNCTION guard_inbound_webhook_action_intent_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM inbound_events AS event
         WHERE event.id = NEW.inbound_event_id
           AND event.tenant_id = NEW.tenant_id
           AND event.endpoint_id = NEW.endpoint_id
    ) THEN
        RAISE EXCEPTION 'inbound webhook action event ownership mismatch';
    END IF;
    IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.inbound_event_id IS DISTINCT FROM OLD.inbound_event_id
       OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
       OR NEW.replay_id IS DISTINCT FROM OLD.replay_id
       OR NEW.intent_kind IS DISTINCT FROM OLD.intent_kind
       OR NEW.trigger_id IS DISTINCT FROM OLD.trigger_id
       OR NEW.trigger_name IS DISTINCT FROM OLD.trigger_name
       OR NEW.action_type IS DISTINCT FROM OLD.action_type
       OR NEW.action_target_id IS DISTINCT FROM OLD.action_target_id
       OR NEW.subscriber_email IS DISTINCT FROM OLD.subscriber_email
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'inbound webhook action snapshots are immutable';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inbound_webhook_action_intents_snapshot_guard
    ON inbound_webhook_action_intents;
CREATE TRIGGER inbound_webhook_action_intents_snapshot_guard
    BEFORE INSERT OR UPDATE ON inbound_webhook_action_intents
    FOR EACH ROW
    EXECUTE FUNCTION guard_inbound_webhook_action_intent_snapshot();

CREATE OR REPLACE FUNCTION guard_inbound_webhook_replay_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM inbound_events AS event
         WHERE event.id = NEW.inbound_event_id
           AND event.tenant_id = NEW.tenant_id
           AND event.endpoint_id = NEW.endpoint_id
    ) THEN
        RAISE EXCEPTION 'inbound webhook replay event ownership mismatch';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inbound_webhook_replay_receipts_guard
    ON inbound_webhook_replay_receipts;
CREATE TRIGGER inbound_webhook_replay_receipts_guard
    BEFORE INSERT OR UPDATE ON inbound_webhook_replay_receipts
    FOR EACH ROW
    EXECUTE FUNCTION guard_inbound_webhook_replay_receipt();

COMMIT;
