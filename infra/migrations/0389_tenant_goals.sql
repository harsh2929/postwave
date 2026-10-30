-- 0389_tenant_goals.sql
--
-- feat/full-surface-wiring: dashboard goals & pacing.
--
-- Operators set per-tenant growth/engagement/revenue targets and the
-- dashboard renders a "pace" chip (ahead | on_track | behind) per
-- goal. The goal row stores WHAT to hit; the current value is always
-- computed live from the existing aggregates (subscribers count,
-- subscriber_events opens, conversions revenue) by
-- apps/api/internal/goals — nothing is denormalised here.
--
--   metric ∈ subscribers | open_rate | revenue_cents | list_growth
--   period ∈ monthly | quarterly  (the pacing window; the goal
--            re-anchors every period boundary from starts_at)
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair using the
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom
-- (raw ::uuid cast crashes when the GUC is unset).
--
-- rollback-strategy: DROP TABLE tenant_goals — additive table, no
-- existing code path reads it before this change set.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_goals (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Which aggregate the goal tracks. See goals/progress.go for the
    -- exact source query per metric.
    metric     TEXT NOT NULL
        CHECK (metric IN ('subscribers','open_rate','revenue_cents','list_growth')),
    -- Target value in the metric's natural unit:
    --   subscribers    → absolute enabled-subscriber count
    --   open_rate      → percentage points (0–100)
    --   revenue_cents  → cents summed over the period
    --   list_growth    → net new subscriber rows over the period
    target     NUMERIC NOT NULL CHECK (target > 0),
    period     TEXT NOT NULL DEFAULT 'monthly'
        CHECK (period IN ('monthly','quarterly')),
    -- Anchor for the pacing windows. The "current period" is the
    -- window [starts_at + n*period, starts_at + (n+1)*period)
    -- containing now().
    starts_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    name       TEXT NOT NULL DEFAULT '',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_goals_tenant_idx
    ON tenant_goals (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_goals TO postwave_app;

ALTER TABLE tenant_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_goals FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_goals
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_goals
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
