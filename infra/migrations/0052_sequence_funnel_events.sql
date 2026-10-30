-- 0052_sequence_funnel_events.sql
--
-- Per-(sequence, subscriber, position) cohort facts so the drip
-- funnel report can answer "how many subscribers reached email 1, 2,
-- 3, 4 of this sequence; what was the open rate at each step?"
--
-- One row per subscriber per email-position they received. Producers:
--
--   - automation runtime, when a send_email node fires for a
--     subscriber walking a sequence-shaped journey.
--   - voice sequence dispatcher (V2), when sequence emails go out
--     directly without going through automation.
--
-- The aggregate query the analytics endpoint runs is:
--
--   SELECT position, count(*) AS reached,
--          count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
--          count(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked
--     FROM sequence_funnel_events
--    WHERE tenant_id = $1 AND sequence_id = $2
--    GROUP BY position
--    ORDER BY position;
--
-- which gives the funnel rows directly. Updates to opened_at /
-- clicked_at come from the listmonk-events handler when it sees the
-- corresponding open/click for a campaign with a sequence_id +
-- email_position attribution attached.

BEGIN;

CREATE TABLE sequence_funnel_events (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sequence_id     uuid NOT NULL,                       -- references voice_sequences(id) but no FK so historical sequences survive a delete
    subscriber_email citext NOT NULL,
    -- 0-indexed position of the email within the sequence.
    position        int NOT NULL,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    opened_at       timestamptz,
    clicked_at      timestamptz,
    UNIQUE (tenant_id, sequence_id, subscriber_email, position)
);

CREATE INDEX sequence_funnel_events_tenant_seq_idx
    ON sequence_funnel_events (tenant_id, sequence_id, position);

GRANT SELECT, INSERT, UPDATE ON sequence_funnel_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE sequence_funnel_events_id_seq TO postwave_app;

ALTER TABLE sequence_funnel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_funnel_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sequence_funnel_events
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
