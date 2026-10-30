-- 0026_sending_domain.sql
--
-- Sending domain: a minimal campaigns table (introduced here because no
-- prior migration defined one), recurrence columns, and a per-tenant
-- sending-settings row used by the worker for throttling and quiet hours.
--
-- The campaigns table is intentionally narrow. Listmonk owns the canonical
-- campaign body; this gateway-side row carries only the metadata our domain
-- layer needs (status, scheduling, parent pointer, recurrence, tenant
-- isolation). Cross-domain features (audience, rendering) stay in Listmonk
-- or in the dedicated audience domain owned by Domain A.

BEGIN;

-- NOTE: The CREATE TABLE campaigns block from the X1 spec was REMOVED on
-- integration. main already has a campaigns table (created by migration
-- 0027_campaigns.sql) with a Listmonk-compatible Phase-3 schema. The
-- branch's "minimal campaigns" schema would have tried to redefine it
-- and failed. The recurrence + parent + send_at + audience_filter
-- columns are added below as ALTER TABLE statements so the existing
-- table picks up the X1 features without disrupting the Listmonk-style
-- columns it already has.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS parent_campaign_id   uuid,
    ADD COLUMN IF NOT EXISTS audience_list_id     bigint,
    ADD COLUMN IF NOT EXISTS audience_segment_id  uuid,
    ADD COLUMN IF NOT EXISTS audience_filter      jsonb,
    ADD COLUMN IF NOT EXISTS send_at              timestamptz,
    ADD COLUMN IF NOT EXISTS started_at           timestamptz,
    ADD COLUMN IF NOT EXISTS finished_at          timestamptz,
    ADD COLUMN IF NOT EXISTS recurrence_cron      text,
    ADD COLUMN IF NOT EXISTS recurrence_until     timestamptz,
    ADD COLUMN IF NOT EXISTS recurrence_last_run  timestamptz;

CREATE INDEX IF NOT EXISTS campaigns_tenant_send_at_idx
    ON campaigns (tenant_id, send_at);
CREATE INDEX IF NOT EXISTS campaigns_recurrence_idx
    ON campaigns (recurrence_cron)
    WHERE recurrence_cron IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaigns_parent_idx
    ON campaigns (parent_campaign_id)
    WHERE parent_campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- campaign_recipients
--
-- Per-recipient send queue. The sending worker dequeues batches from here
-- and consults the parent campaign's status before each batch. Cancellation
-- mid-flight flips status to cancelled and the worker stops dequeuing.
-- ---------------------------------------------------------------------------
CREATE TABLE campaign_recipients (
    id               bigserial PRIMARY KEY,
    campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email citext NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                      CHECK (status IN
                        ('pending','sent','failed','cancelled','skipped')),
    sent_at          timestamptz,
    error            text
);

CREATE INDEX campaign_recipients_campaign_status_idx
    ON campaign_recipients (campaign_id, status);
CREATE INDEX campaign_recipients_tenant_idx
    ON campaign_recipients (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_recipients TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_recipients_id_seq TO postwave_app;

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_recipients
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- tenant_sending_settings
--
-- Per-tenant rate limits and quiet hours. One row per tenant; absence
-- means unlimited / no quiet hours.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_sending_settings (
    tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    max_sends_per_hour  int,
    quiet_hours_start   text,
    quiet_hours_end     text,
    quiet_hours_tz      text,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_sending_settings TO postwave_app;

ALTER TABLE tenant_sending_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sending_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_sending_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- tenant_send_rate_buckets
--
-- Postgres-backed token bucket for the per-tenant hourly send cap. Used by
-- the sending worker when Redis is not configured (which is the case for
-- the api gateway today; the automation service has Redis but the send
-- loop runs in the gateway's worker process).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_send_rate_buckets (
    tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    window_start timestamptz NOT NULL DEFAULT now(),
    sent_count  int NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON tenant_send_rate_buckets TO postwave_app;

ALTER TABLE tenant_send_rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_send_rate_buckets FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_send_rate_buckets
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
