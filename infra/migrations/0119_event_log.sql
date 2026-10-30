-- 0119_event_log.sql
--
-- Persistent append-only log behind the /api/v1/events SSE stream so
-- consumers can replay from a cursor after a disconnect (Redis Streams
-- style without the operational overhead — for our event volume,
-- Postgres bigserial + GIN-on-topic is plenty).
--
-- The Bus.Publish() path opportunistically writes here when a writer
-- is wired. SSE consumers passing ?since=<cursor> first drain the
-- log up to the latest row, then switch to live tailing.
--
-- Retention: 7-day rolling window via a janitor (see
-- apps/api/internal/events). The log is for replay, not durable
-- analytics — the analytics warehouse owns long-term storage.

BEGIN;

CREATE TABLE IF NOT EXISTS event_log (
    sequence_id  bigserial PRIMARY KEY,
    tenant_id    uuid NOT NULL,
    topic        text NOT NULL,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_log_tenant_seq
    ON event_log (tenant_id, sequence_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_tenant_topic
    ON event_log (tenant_id, topic, sequence_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_at
    ON event_log (at);

GRANT SELECT, INSERT, DELETE ON event_log TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE event_log_sequence_id_seq TO postwave_app;

ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON event_log AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Background writers (publishers running outside a request) bind
-- app.outbox_worker='true'.
CREATE POLICY event_log_worker_all ON event_log AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
