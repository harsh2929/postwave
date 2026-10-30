-- 0411_segment_membership_log.sql
--
-- Segment Decay Radar (feature #5) — per-member entrant/leaver event log.
--
-- Written by the DecayWorker (decay_worker.go) after each snapshot tick.
-- One row per (segment, subscriber, direction) per UTC day. This is the
-- true per-member diff store that segment_size_history (count-only,
-- migration 0392) lacks: it lets the attribution query diff the exact
-- exit set against each top-level AST clause offline.
--
-- VOLUME SAFETY: the worker enforces a hard cap of 1,000 rows per
-- direction per segment per day in application code (D1, approved). The
-- cap is applied BEFORE the INSERT batch is built (the before/after
-- membership sets are diffed in Go memory, bounded by the
-- snapshotMaxSegmentsPerTenantPerTick limit), never as a LIMIT on a
-- per-subscriber cursor. clause_attrs records, for a leaver, which
-- top-level AST clauses still matched at exit time (for attribution).
--
-- rollback-strategy: no-op — additive table; prior releases never read
-- it, so leaving it in place during a rollback is safe. Hard rollback =
-- DROP TABLE segment_membership_log.

BEGIN;

CREATE TABLE IF NOT EXISTS segment_membership_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
    segment_id    uuid        NOT NULL REFERENCES segments(id)    ON DELETE CASCADE,
    subscriber_id uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    email         citext      NOT NULL,
    direction     text        NOT NULL CHECK (direction IN ('entered', 'left')),
    snapshot_date date        NOT NULL DEFAULT CURRENT_DATE,
    clause_attrs  jsonb,           -- {clause_index: bool} for leavers
    logged_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE segment_membership_log IS
    'Per-member entrant/leaver log written by the decay worker after each snapshot. clause_attrs records which top-level AST clauses still matched when a subscriber left (for attribution). Bounded to 1,000 rows/direction/segment/day in app code (D1).';

CREATE INDEX IF NOT EXISTS segment_membership_log_segment_date_idx
    ON segment_membership_log (tenant_id, segment_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS segment_membership_log_subscriber_idx
    ON segment_membership_log (tenant_id, subscriber_id, snapshot_date DESC);

GRANT SELECT, INSERT, DELETE ON segment_membership_log TO postwave_app;

ALTER TABLE segment_membership_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_membership_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON segment_membership_log
    AS RESTRICTIVE FOR ALL
    USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON segment_membership_log
    AS PERMISSIVE FOR ALL TO postwave_app
    USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
