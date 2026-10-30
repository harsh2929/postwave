-- 0251_list_health_history.sql
--
-- GAP-LS-119 / GAP-LS-143: append-only daily snapshot of per-list
-- deliverability + engagement scores. Without this table the existing
-- list_health surface is point-in-time only (today's 90d window), so
-- operators cannot tell whether the score is trending up or down.
-- Klaviyo's Deliverability Hub history graph is the parity target.
--
-- A daily-tick worker (lands in a separate package later) writes
-- one row per (tenant, list_id, sampled_at::date). Schema only here.
--
-- The per-list scoring itself depends on GAP-LS-044 (mirror native
-- subscribes) + GAP-LS-045 (bigint/uuid mismatch fix) landing first.
-- This migration is the data sink — the worker that fills it can
-- ship asynchronously without a code freeze on this table shape.

BEGIN;

CREATE TABLE IF NOT EXISTS list_health_history (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    list_id               uuid NOT NULL,
    sampled_at            timestamptz NOT NULL DEFAULT now(),
    window_days           int NOT NULL DEFAULT 90 CHECK (window_days BETWEEN 1 AND 365),
    score                 int NOT NULL CHECK (score BETWEEN 0 AND 100),
    grade                 text NOT NULL CHECK (grade IN ('A','B','C','D','F')),
    bounce_rate           numeric(6,4) NOT NULL DEFAULT 0,
    complaint_rate        numeric(6,4) NOT NULL DEFAULT 0,
    unsubscribe_rate      numeric(6,4) NOT NULL DEFAULT 0,
    engagement_rate       numeric(6,4) NOT NULL DEFAULT 0,
    active_subscribers    int NOT NULL DEFAULT 0,
    total_subscribers     int NOT NULL DEFAULT 0,
    blocklisted_count     int NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- Per-list history chart query: tenant + list, scan back N days.
CREATE INDEX IF NOT EXISTS list_health_history_lookup_idx
    ON list_health_history (tenant_id, list_id, sampled_at DESC);

-- Daily-tick uniqueness: collapses retries of the worker on the same
-- (tenant, list, day). Window is a date — we truncate sampled_at to
-- the day so two runs on the same day collapse via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS list_health_history_daily_unique
    ON list_health_history (tenant_id, list_id, ((sampled_at AT TIME ZONE 'UTC')::date), window_days);

GRANT SELECT, INSERT, UPDATE, DELETE ON list_health_history TO postwave_app;

ALTER TABLE list_health_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_health_history FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON list_health_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON list_health_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
