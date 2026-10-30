-- 0013_subscriber_events.sql
--
-- Append-only log of subscriber engagement events ingested from Listmonk's
-- webhooks. The automation runtime reads this log to evaluate triggers like
-- "subscriber_opened_email" / "subscriber_clicked_link" / the
-- "did_not_open" laggard-evaluator job.
--
-- Cardinality assumption: high. We index for the two dominant access shapes:
--   1. trigger evaluation: (tenant_id, subscriber_email, event_type, at desc)
--   2. campaign rollups:   (tenant_id, campaign_id, at desc)
--
-- We deliberately keep this table tenant-RLS-isolated even though the
-- ingester writes from an internal endpoint — the writes happen inside a
-- WithTenant transaction so the policy still gates access correctly.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE subscriber_events (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email  citext NOT NULL,
    event_type        text NOT NULL CHECK (event_type IN
                          ('opened','clicked','bounced','complained','unsubscribed')),
    campaign_id       uuid,
    link_url          text,
    user_agent        text,
    ip                inet,
    at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriber_events_subscriber_idx
    ON subscriber_events (tenant_id, subscriber_email, event_type, at DESC);
CREATE INDEX subscriber_events_campaign_idx
    ON subscriber_events (tenant_id, campaign_id, at DESC);

GRANT SELECT, INSERT ON subscriber_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE subscriber_events_id_seq TO postwave_app;

ALTER TABLE subscriber_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriber_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
