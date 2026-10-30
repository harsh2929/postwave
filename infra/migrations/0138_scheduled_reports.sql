-- 0138_scheduled_reports.sql
--
-- Scheduled email digests. Operators define a report once
-- ("weekly engagement summary, every Monday at 9am, to
-- founders@acme.com"); the worker fires on the schedule and
-- delivers a formatted email summarising the last period.
--
-- Schedule format: simplified cron. V1 supports weekly + monthly:
--
--   "weekly:mon@09:00"     every Monday at 09:00 UTC
--   "weekly:fri@17:00"     every Friday at 17:00 UTC
--   "monthly:1@09:00"      1st of every month at 09:00 UTC
--   "monthly:15@09:00"     15th of every month
--
-- Body template selects which metrics to include (sends / opens /
-- clicks / bounces / new_subscribers / unsubscribes). V1 has one
-- canonical "engagement_summary" template; operators pick
-- recipients + schedule.

BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    name            text NOT NULL,
    enabled         boolean NOT NULL DEFAULT true,
    template        text NOT NULL DEFAULT 'engagement_summary'
                       CHECK (template IN ('engagement_summary','deliverability','growth')),
    schedule        text NOT NULL,
    recipients      text[] NOT NULL,
    last_run_at     timestamptz,
    last_run_error  text,
    -- next_due_at is computed by the worker on every tick + cached
    -- here so the dashboard can show "next run at HH:MM" without
    -- re-parsing the schedule.
    next_due_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_tenant
    ON scheduled_reports (tenant_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_due
    ON scheduled_reports (next_due_at)
    WHERE enabled = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_reports TO postwave_app;

ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON scheduled_reports AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
