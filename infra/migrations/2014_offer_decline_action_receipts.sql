-- 2014_offer_decline_action_receipts.sql
--
-- Complete the only ticketable F15 offer action. A decline records intent; it
-- does not reserve inventory or complete a purchase. The bearer is bound to
-- the exact canonical offer projection that existed at mint time, and this
-- trigger rejects an insert unless the matching single-use ticket currently
-- owns an execution lease. Offer acceptance remains deliberately unticketable.

BEGIN;

ALTER TABLE action_tickets
    ADD COLUMN IF NOT EXISTS resource_version text;

ALTER TABLE action_tickets
    DROP CONSTRAINT IF EXISTS action_tickets_resource_version_shape,
    ADD CONSTRAINT action_tickets_resource_version_shape CHECK (
        resource_version IS NULL
        OR resource_version ~ '^[0-9a-f]{64}$'
    ),
    DROP CONSTRAINT IF EXISTS action_tickets_offer_decline_is_versioned,
    ADD CONSTRAINT action_tickets_offer_decline_is_versioned CHECK (
        action <> 'offer.decline'
        OR (resource_kind = 'offer' AND resource_version IS NOT NULL)
    );

COMMENT ON COLUMN action_tickets.resource_version IS
    'Exact mutable-domain projection hash bound at mint time. Required for offer.decline so an old bearer cannot decide a redefined offer.';

CREATE TABLE IF NOT EXISTS offer_decline_decisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    offer_id            uuid NOT NULL,
    user_id             uuid NOT NULL,
    action_ticket_id    uuid NOT NULL,
    offer_version_hash  text NOT NULL CHECK (offer_version_hash ~ '^[0-9a-f]{64}$'),
    decided_at          timestamptz NOT NULL,
    receipt_hash        text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    created_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT offer_decline_decisions_one_per_user
        UNIQUE (tenant_id, offer_id, user_id),
    CONSTRAINT offer_decline_decisions_ticket_unique
        UNIQUE (action_ticket_id)
);

ALTER TABLE offer_decline_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_decline_decisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offer_decline_decisions_tenant_select
    ON offer_decline_decisions;
CREATE POLICY offer_decline_decisions_tenant_select
    ON offer_decline_decisions
    FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS offer_decline_decisions_tenant_insert
    ON offer_decline_decisions;
CREATE POLICY offer_decline_decisions_tenant_insert
    ON offer_decline_decisions
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

REVOKE ALL ON offer_decline_decisions FROM PUBLIC, postwave_app;
GRANT SELECT, INSERT ON offer_decline_decisions TO postwave_app;

CREATE OR REPLACE FUNCTION enforce_offer_decline_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    current_offer offers%ROWTYPE;
    current_version text;
BEGIN
    SELECT offer.*
      INTO current_offer
      FROM offers AS offer
     WHERE offer.tenant_id = NEW.tenant_id
       AND offer.id = NEW.offer_id
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'offer decline resource is unavailable'
            USING ERRCODE = '23514';
    END IF;

    current_version := encode(digest(convert_to(
        to_jsonb(current_offer)::text, 'UTF8'
    ), 'sha256'), 'hex');

    IF current_version <> NEW.offer_version_hash
       OR (current_offer.valid_from IS NOT NULL
           AND NEW.decided_at < current_offer.valid_from)
       OR (current_offer.valid_until IS NOT NULL
           AND NEW.decided_at >= current_offer.valid_until)
       OR current_offer.inventory_state NOT IN ('in_stock', 'limited') THEN
        RAISE EXCEPTION 'offer decline resource is stale'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM action_tickets AS ticket
         WHERE ticket.id = NEW.action_ticket_id
           AND ticket.tenant_id = NEW.tenant_id
           AND ticket.user_id = NEW.user_id
           AND ticket.action = 'offer.decline'
           AND ticket.resource_kind = 'offer'
           AND ticket.resource_id = NEW.offer_id::text
           AND ticket.resource_version = NEW.offer_version_hash
           AND ticket.used_at IS NULL
           AND ticket.expires_at > statement_timestamp()
           AND ticket.execution_id IS NOT NULL
           AND ticket.execution_started_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'offer decline ticket lease is invalid'
            USING ERRCODE = '23514';
    END IF;

    NEW.receipt_hash := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.offer-decline-receipt.v1',
        'tenant_id', NEW.tenant_id,
        'offer_id', NEW.offer_id,
        'user_id', NEW.user_id,
        'action_ticket_id', NEW.action_ticket_id,
        'offer_version_hash', NEW.offer_version_hash,
        'decided_at', NEW.decided_at
    )::text, 'UTF8'), 'sha256'), 'hex');
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS offer_decline_decisions_guard
    ON offer_decline_decisions;
CREATE TRIGGER offer_decline_decisions_guard
    BEFORE INSERT ON offer_decline_decisions
    FOR EACH ROW EXECUTE FUNCTION enforce_offer_decline_decision();

COMMENT ON TABLE offer_decline_decisions IS
    'Append-only F15 records-intent receipts. The application role can select and insert only; a guard binds every insert to an active offer.decline ticket lease and the exact canonical offer hash.';

COMMIT;
