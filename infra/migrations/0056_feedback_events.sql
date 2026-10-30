-- 0056_feedback_events.sql
--
-- Bounce + complaint feedback-loop (FBL) events.
--
-- We delegate sending to Listmonk, but the actual ESP under it (Postmark,
-- SendGrid, AWS SES) is the source of truth for deliverability signals.
-- Each ESP exposes a different webhook payload; the gateway parses each
-- shape into a canonical bounce_events / complaint_events row and lets the
-- repo layer decide whether to also write to the existing
-- email_suppressions table (defined in 0030).
--
-- Design notes:
--   * Append-only. We never UPDATE these tables; they are the audit log.
--   * Subscriber identity is keyed by email (citext) since at FBL time
--     the ESP rarely echoes our subscriber UUID — the bounce report only
--     carries the recipient address and the ESP's own message id.
--   * raw is the verbatim payload we received, kept so support can replay
--     a tenant's exact ESP signal months later (e.g. for Postmark
--     SuppressionAdded back-fills).
--   * RLS mirrors every other tenant-scoped table: tenant_isolation
--     keyed on app.tenant_id GUC set by db.WithTenant.

BEGIN;

CREATE TABLE bounce_events (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email citext NOT NULL,
    bounce_type      text NOT NULL CHECK (bounce_type IN ('hard', 'soft', 'transient')),
    esp              text NOT NULL,
    esp_message_id   text,
    raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bounce_events_tenant_email_idx
    ON bounce_events (tenant_id, subscriber_email, received_at DESC);

GRANT SELECT, INSERT, UPDATE ON bounce_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE bounce_events_id_seq TO postwave_app;

ALTER TABLE bounce_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bounce_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE complaint_events (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email citext NOT NULL,
    complaint_type   text CHECK (complaint_type IN ('abuse', 'fbl', 'spam')),
    esp              text,
    esp_message_id   text,
    raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX complaint_events_tenant_email_idx
    ON complaint_events (tenant_id, subscriber_email, received_at DESC);

GRANT SELECT, INSERT, UPDATE ON complaint_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE complaint_events_id_seq TO postwave_app;

ALTER TABLE complaint_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON complaint_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
