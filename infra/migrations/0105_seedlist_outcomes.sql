-- 0105_seedlist_outcomes.sql
--
-- Durable Inbox Reality seed-list observations. The deliverability service
-- upserts one latest placement per tenant/campaign/mailbox so campaign reports
-- survive restarts and can feed the spam-scorer recalibration exporter.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS seedlist_outcomes (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id     uuid NOT NULL,
    variant_id      uuid,
    recipient_email citext NOT NULL,
    mailbox_id      text NOT NULL,
    provider        text NOT NULL,
    folder          text NOT NULL
                    CHECK (folder IN ('primary','promotions','updates','social','spam','blocked','missing')),
    checked_at      timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, campaign_id, mailbox_id)
);

CREATE INDEX IF NOT EXISTS seedlist_outcomes_campaign_idx
    ON seedlist_outcomes (tenant_id, campaign_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS seedlist_outcomes_training_idx
    ON seedlist_outcomes (checked_at DESC, folder);

CREATE TRIGGER seedlist_outcomes_set_updated_at
    BEFORE UPDATE ON seedlist_outcomes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE seedlist_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY seedlist_outcomes_tenant_isolation
    ON seedlist_outcomes
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
