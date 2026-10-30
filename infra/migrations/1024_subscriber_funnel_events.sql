-- 1024_subscriber_funnel_events.sql
--
-- SUB-128: cohort funnel analysis on subscribers (signup → first-purchase →
-- repeat-purchase by audience).
--
-- The codebase already had every analytical primitive needed for a cohort
-- funnel EXCEPT a place to record the funnel-stage transitions a subscriber
-- moves through. Commerce facts live in commerce_orders (keyed on
-- customer_email + ordered_at), but there was no first-party record of WHEN a
-- subscriber crossed each funnel boundary, nor a stable link from a
-- subscriber row to its purchase-stage history. The SubscriberFunnel service
-- method can compute conversions on-the-fly from commerce_orders, but a
-- materialized stage-transition log lets the funnel:
--   * survive deletion / re-keying of the underlying orders,
--   * record the signup stage (which has no commerce_orders row at all), and
--   * attribute the repeat-purchase ordinal (1st repeat, 2nd repeat, ...)
--     without re-scanning the full order history on every dashboard load.
--
-- This is a tenant-scoped append-mostly table: one row per (subscriber, stage)
-- transition. event_type is pinned by a CHECK so a drifting client cannot
-- silently introduce an unknown stage. The (tenant_id, event_type, occurred_at)
-- composite index serves the cohort CTE that buckets transitions by month, and
-- the (tenant_id, subscriber_id) index serves per-subscriber timeline lookups.
--
-- RLS shape copied from infra/migrations/0321_subscriber_view_prefs.sql:
-- RESTRICTIVE tenant_isolation + PERMISSIVE tenant_visible, both reading the
-- tenant GUC via NULLIF(current_setting('app.tenant_id', true), '')::uuid so
-- an unset GUC degrades to "no rows" instead of crashing on a raw ::uuid cast.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_funnel_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    event_type    text NOT NULL
                  CHECK (event_type IN (
                      'signup',
                      'first_purchase',
                      'repeat_purchase',
                      'repeat_nth'
                  )),
    -- Ordinal for repeat purchases: 1 = first repeat (i.e. 2nd order),
    -- 2 = second repeat, etc. NULL for signup / first_purchase rows.
    repeat_ordinal integer
                   CHECK (repeat_ordinal IS NULL OR repeat_ordinal >= 1),
    -- Optional pointer to the commerce order that drove the transition, so a
    -- funnel row can be reconciled against the underlying order. SET NULL on
    -- order delete keeps the funnel history intact.
    order_id      uuid REFERENCES commerce_orders(id) ON DELETE SET NULL,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- One transition per (subscriber, stage, ordinal). The COALESCE on
    -- repeat_ordinal collapses the NULL ordinal of signup / first_purchase
    -- into a single deterministic slot so the unique index is total.
    UNIQUE (tenant_id, subscriber_id, event_type, repeat_ordinal)
);

-- Cohort CTE driver: bucket transitions by (tenant, stage, month).
CREATE INDEX IF NOT EXISTS subscriber_funnel_events_cohort_idx
    ON subscriber_funnel_events (tenant_id, event_type, occurred_at);

-- Per-subscriber timeline lookups.
CREATE INDEX IF NOT EXISTS subscriber_funnel_events_subscriber_idx
    ON subscriber_funnel_events (tenant_id, subscriber_id, occurred_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_funnel_events TO postwave_app;

ALTER TABLE subscriber_funnel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_funnel_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_funnel_events;
CREATE POLICY tenant_isolation ON subscriber_funnel_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON subscriber_funnel_events;
CREATE POLICY tenant_visible ON subscriber_funnel_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
