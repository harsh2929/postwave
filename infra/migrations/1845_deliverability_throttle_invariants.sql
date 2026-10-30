-- 1845_deliverability_throttle_invariants.sql
--
-- Production invariants for the deliverability reputation-repair throttle:
--   * at most one active override per tenant;
--   * durable, cadence-aware low-score state (a few sparse snapshots must not
--     stand in for 24 continuous hours below the threshold);
--   * deterministic repair of duplicate active rows created by the former
--     check-then-insert worker.
-- rollback-strategy: no-op - retain the unique active-override invariant and
-- durable observation state while rolling application code back.
-- rollback-details: older code ignores deliverability_throttle_state; dropping
-- it or the unique index would re-open duplicate cap reductions.

BEGIN;

-- Stop the old worker from adding another duplicate while the historical rows
-- are reconciled and the unique index is installed.
LOCK TABLE deliverability_repair_overrides IN SHARE ROW EXCLUSIVE MODE;

-- A duplicate set can only have arisen from concurrent workers. Keep the
-- oldest row because its prior_max_sends_per_hour is the cap that existed
-- before any throttle fired. Clear the later rows and restore the effective cap
-- to the keeper's single-reduction value, undoing accidental double-halving.
WITH ranked AS MATERIALIZED (
    SELECT id,
           tenant_id,
           throttled_max_sends_per_hour,
           row_number() OVER (
               PARTITION BY tenant_id
               ORDER BY created_at ASC, id ASC
           ) AS position,
           count(*) OVER (PARTITION BY tenant_id) AS active_count
      FROM deliverability_repair_overrides
     WHERE cleared_at IS NULL
), cleared AS (
    UPDATE deliverability_repair_overrides AS repair
       SET cleared_at = now(),
           cleared_by = COALESCE(
               repair.cleared_by,
               'system:migration-1845-active-override-dedup'
           )
      FROM ranked
     WHERE repair.id = ranked.id
       AND ranked.active_count > 1
       AND ranked.position > 1
    RETURNING repair.tenant_id
), keepers AS (
    SELECT tenant_id, throttled_max_sends_per_hour
      FROM ranked
     WHERE active_count > 1
       AND position = 1
)
UPDATE tenant_sending_settings AS settings
   SET max_sends_per_hour = keepers.throttled_max_sends_per_hour,
       updated_at = now()
  FROM keepers
 WHERE settings.tenant_id = keepers.tenant_id
   AND EXISTS (
       SELECT 1
         FROM cleared
        WHERE cleared.tenant_id = keepers.tenant_id
   );

CREATE UNIQUE INDEX IF NOT EXISTS
    deliverability_repair_overrides_one_active_per_tenant_uidx
    ON deliverability_repair_overrides (tenant_id)
    WHERE cleared_at IS NULL;

-- This row is the durable observation state used by every replica. low_since
-- is reset by a healthy score or by a missed observation cadence; therefore
-- elapsed wall time alone cannot turn sparse samples into a throttle.
CREATE TABLE IF NOT EXISTS deliverability_throttle_state (
    tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    low_since        timestamptz,
    last_sampled_at  timestamptz NOT NULL,
    last_score       integer NOT NULL CHECK (last_score BETWEEN 0 AND 100),
    sample_qualified boolean NOT NULL DEFAULT false,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT deliverability_throttle_state_low_since_order_chk
        CHECK (low_since IS NULL OR low_since <= last_sampled_at)
);

CREATE INDEX IF NOT EXISTS deliverability_throttle_state_low_since_idx
    ON deliverability_throttle_state (low_since)
    WHERE low_since IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON deliverability_throttle_state TO postwave_app;

ALTER TABLE deliverability_throttle_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverability_throttle_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON deliverability_throttle_state;
CREATE POLICY tenant_isolation ON deliverability_throttle_state
    AS RESTRICTIVE FOR ALL
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id::text = COALESCE(
            NULLIF(current_setting('app.tenant_id', true), ''),
            '00000000-0000-0000-0000-000000000000'
        )
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id::text = COALESCE(
            NULLIF(current_setting('app.tenant_id', true), ''),
            '00000000-0000-0000-0000-000000000000'
        )
    );

DROP POLICY IF EXISTS tenant_visible ON deliverability_throttle_state;
CREATE POLICY tenant_visible ON deliverability_throttle_state
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id::text = COALESCE(
            NULLIF(current_setting('app.tenant_id', true), ''),
            '00000000-0000-0000-0000-000000000000'
        )
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id::text = COALESCE(
            NULLIF(current_setting('app.tenant_id', true), ''),
            '00000000-0000-0000-0000-000000000000'
        )
    );

COMMIT;
