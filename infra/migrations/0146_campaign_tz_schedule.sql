-- 0146_campaign_tz_schedule.sql
--
-- Recipient-timezone-aware scheduling.
--
-- The operator declares "9am Tuesday in the recipient's timezone";
-- the dispatcher wakes up each hour and releases the slice of the
-- audience whose local time has just crossed that wall-clock hour.
--
-- Schema:
--   tz_window_local      local time of day at which to release
--   tz_window_date       calendar date (RFC 3339 date, NO TZ) the
--                        operator picked
--   fallback_tz          IANA tz used when subscribers have no
--                        per-row timezone (custom_fields ->> 'timezone'
--                        absent)
--   started_at           when the dispatcher first picked it up
--   completed_at         when every timezone bucket was released

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_tz_schedules (
    campaign_id      uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tz_window_local  time NOT NULL,
    tz_window_date   date NOT NULL,
    fallback_tz      text NOT NULL DEFAULT 'UTC',
    started_at       timestamptz,
    completed_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_tz_schedules_tenant
    ON campaign_tz_schedules (tenant_id, completed_at NULLS FIRST);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_tz_schedules TO postwave_app;

ALTER TABLE campaign_tz_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_tz_schedules AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
