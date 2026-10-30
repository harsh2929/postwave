-- 0412_segment_decay_alerts.sql
--
-- Segment Decay Radar (feature #5) — detected-anomaly header table plus
-- the email notification preference column.
--
-- segment_decay_events caches the structured fields of each detected
-- anomaly so the desktop can query them without parsing audit_log
-- metadata JSON. The canonical event still lives in audit_log
-- (action='segment.decay'); audit_event_id is a best-effort back-pointer
-- to that row. anomaly_kind is one of:
--   'size_cliff'         — membership dropped past the cliff threshold
--   'zero_match'         — predicate now matches nobody
--   'everyone_match'     — predicate now matches every subscriber
--   'definition_changed' — the segment definition changed recently (D5)
--
-- narration / narration_model are NULLABLE: LLM narration is on-demand
-- (D3, POST /narrate), so most rows carry no narration. The UI hides the
-- narration block entirely when narration IS NULL (honest-UI: never
-- fabricate).
--
-- notification_preferences.email_on_segment_decay defaults to TRUE
-- (fail-open, consistent with the other email_on_* pref columns); the
-- DecayWorker's direct-email path (D4 Option C) gates on it via
-- notifications.Dispatcher before sending.
--
-- rollback-strategy: no-op — additive table + one nullable-default
-- column; prior releases never touch them. Hard rollback = DROP TABLE
-- segment_decay_events; ALTER TABLE notification_preferences DROP COLUMN
-- email_on_segment_decay (both safe on Postgres 11+). Back up
-- segment_decay_events before a production rollback if rows exist.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_decay_events (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
    segment_id      uuid        NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    snapshot_date   date        NOT NULL,
    anomaly_kind    text        NOT NULL
                    CHECK (anomaly_kind IN
                        ('size_cliff', 'zero_match', 'everyone_match', 'definition_changed')),
    prior_count     integer     NOT NULL DEFAULT 0,
    new_count       integer     NOT NULL DEFAULT 0,
    leaver_count    integer     NOT NULL DEFAULT 0,
    entrant_count   integer     NOT NULL DEFAULT 0,
    clause_attrs    jsonb,                 -- {clause_index: leaver_count, ...}
    narration       text,                  -- LLM "who left and why"; NULL until /narrate
    narration_model text,                  -- e.g. 'claude-3-5-sonnet-20241022'
    dismissed_at    timestamptz,
    audit_event_id  bigint,                -- best-effort FK to audit_log.id
    created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE segment_decay_events IS
    'Detected segment anomalies (cliff, zero, everyone, definition_changed) with clause attribution. The audit_log row (action=segment.decay) is the canonical event; this table accelerates the UI query. narration is on-demand (D3) and may be NULL.';

CREATE INDEX IF NOT EXISTS segment_decay_events_segment_idx
    ON segment_decay_events (tenant_id, segment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS segment_decay_events_undismissed_idx
    ON segment_decay_events (tenant_id, dismissed_at)
    WHERE dismissed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON segment_decay_events TO postwave_app;

ALTER TABLE segment_decay_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_decay_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON segment_decay_events
    AS RESTRICTIVE FOR ALL
    USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_decay_events
    AS PERMISSIVE FOR ALL TO postwave_app
    USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Email notification preference for decay alerts (D4 Option C).
-- DEFAULT true = fail-open: all tenants get decay email until they opt
-- out, matching the other email_on_* columns.
ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS email_on_segment_decay boolean NOT NULL DEFAULT true;

COMMIT;
