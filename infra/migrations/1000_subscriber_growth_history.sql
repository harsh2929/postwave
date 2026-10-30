-- 1000_subscriber_growth_history.sql
--
-- SUB-124 Audience growth report — daily audience lifecycle snapshots.
--
-- The dashboard already surfaces single-window aggregates (total,
-- added30d, unsubbed30d) but has no historical series to chart trend or
-- detect anomalies. This table is the subscriber-level analogue of
-- segment_size_history (migration 0392): one row per tenant per UTC day
-- carrying the lifecycle counts the audience growth chart reads.
--
--   total_count : SELECT count(*) FROM subscribers (current size)
--   added_count : subscribers created on this snapshot_date
--   unsubbed_count : subscribers whose status flipped to 'blocklisted'
--                    (updated) on this snapshot_date
--   lapsed_count : currently-reserved for engagement-decay lapses; the
--                  worker writes 0 until the lapse signal is wired, so
--                  the column exists for forward-compat without a later
--                  ALTER.
--
-- A daily worker (subscribers/snapshot_worker.go) walks every tenant and
-- upserts one row per (tenant, day). The GET /api/v1/subscribers/growth
-- endpoint reads the resulting series and computes delta/deltaPct.
--
-- RLS: canonical RESTRICTIVE + PERMISSIVE pair using the NULLIF idiom (a
-- raw ::uuid cast crashes on an unset GUC). The worker writes under
-- per-tenant scope (db.WithTenant), so no worker gate is needed here —
-- shape copied from segment_size_history (0392).
--
-- rollback-strategy: DROP TABLE subscriber_growth_history — the read path
-- tolerates the table being absent (degrades to an empty series + note).

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_growth_history (
    tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    snapshot_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
    evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_count    INTEGER     NOT NULL DEFAULT 0,
    added_count    INTEGER     NOT NULL DEFAULT 0,
    unsubbed_count INTEGER     NOT NULL DEFAULT 0,
    lapsed_count   INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, snapshot_date)
);

COMMENT ON TABLE subscriber_growth_history IS
    'Daily audience lifecycle counts (total/added/unsubbed/lapsed) written by the subscriber growth snapshot worker; read by GET /api/v1/subscribers/growth (SUB-124).';

-- Chart read path: "points for this tenant in the last N days".
CREATE INDEX IF NOT EXISTS subscriber_growth_history_date_idx
    ON subscriber_growth_history (tenant_id, snapshot_date ASC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_growth_history TO postwave_app;

ALTER TABLE subscriber_growth_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_growth_history FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_growth_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_growth_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
