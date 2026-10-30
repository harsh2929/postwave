-- 0265_audit_replay_jobs.sql
--
-- Signed export manifests + cursor-based audit-sink replay/backfill.
--
-- Adds two tables:
--
--   1. audit_sink_replay_jobs — one row per operator-initiated replay.
--      Tracks (sink_id, from_audit_id, to_audit_id, status, progress,
--      cursor). The auditsink delivery worker polls pending/in_progress
--      jobs, loads rows in BatchSize windows, respects the per-sink
--      circuit breaker, and updates next_cursor_id after each batch so
--      partial work survives worker restarts.
--
--   2. audit_export_manifests — metadata for each signed CSV export
--      bundle. Stores the canonical filter, audit_log id range, row
--      count, signed root hash, and the kid the operator can use to
--      verify the bundle independently. The CSV is downloaded inline;
--      the manifest row is the audit trail of "yes, we issued this
--      bundle and signed root X covers it".
--
-- RLS pattern: every policy reads tenant_id via the NULLIF GUC idiom
-- (NULLIF(current_setting('app.tenant_id', true), '')::uuid) so an
-- unset GUC degrades to NULL instead of crashing the query (Postwave
-- house style; see infra/migrations/0123_audit_sinks_and_merkle.sql
-- and 0264_audit_sink_keys.sql).

BEGIN;

-- ----------------------------------------------------------------------
-- audit_sink_replay_jobs
-- ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_sink_replay_jobs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    sink_id           uuid NOT NULL REFERENCES audit_sinks(id) ON DELETE CASCADE,
    -- [from_audit_id, to_audit_id] is inclusive on both ends. The
    -- API enforces from <= to and a 100k-row ceiling per job.
    from_audit_id     bigint NOT NULL,
    to_audit_id       bigint NOT NULL,
    -- Lifecycle:
    --   pending     — created by operator, waiting for the worker
    --   in_progress — worker has claimed it; next_cursor_id moves forward
    --   completed   — every row in the range has been delivered
    --   failed      — irrecoverable (circuit open past max retries, or
    --                 delivery returned a non-retryable error)
    --   cancelled   — operator hit the cancel endpoint
    status            text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    rows_sent         bigint NOT NULL DEFAULT 0,
    rows_failed       bigint NOT NULL DEFAULT 0,
    last_error        text,
    -- Cursor for resuming this job after worker restart / mid-batch
    -- crash. NULL = haven't started; otherwise the highest audit_log.id
    -- successfully delivered (next batch reads id > next_cursor_id).
    next_cursor_id    bigint,
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    completed_at      timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- Optional audit trail of who kicked off the replay. Free-form
    -- (matches actor_label semantics in audit_log).
    created_by        text,
    CHECK (from_audit_id <= to_audit_id)
);

-- Worker hot-path: "give me the next pending/in_progress job ordered
-- oldest-first". Keyed by sink so the worker can serialise per-sink
-- replays without a separate join.
CREATE INDEX IF NOT EXISTS idx_audit_sink_replay_jobs_worker
    ON audit_sink_replay_jobs (sink_id, status, created_at)
    WHERE status IN ('pending', 'in_progress');

-- Tenant-scoped list / pagination index. created_at DESC matches the
-- API's default ordering (newest first).
CREATE INDEX IF NOT EXISTS idx_audit_sink_replay_jobs_tenant
    ON audit_sink_replay_jobs (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON audit_sink_replay_jobs TO postwave_app;

ALTER TABLE audit_sink_replay_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON audit_sink_replay_jobs
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Worker access (same app.outbox_worker GUC the delivery + merkle +
-- key-rotator workers use) so the replay worker can scan / advance
-- jobs across every tenant without per-tenant GUC juggling.
CREATE POLICY audit_replay_jobs_worker_all ON audit_sink_replay_jobs
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- ----------------------------------------------------------------------
-- audit_export_manifests
-- ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_export_manifests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    -- Operator-visible filename stem (YYYYMMDD-HHMMSS-<rand6>). Unique
    -- per tenant so two operators clicking Export in the same second
    -- still produce distinct bundles.
    export_id         text NOT NULL,
    -- Canonical JSON of the filter set used to produce the CSV (actor,
    -- action, resource_type, resource_id, since). Stored so a verifier
    -- can re-run the same query and confirm the row set matches.
    filters_canonical jsonb NOT NULL DEFAULT '{}'::jsonb,
    from_audit_id     bigint NOT NULL,
    to_audit_id       bigint NOT NULL,
    row_count         bigint NOT NULL,
    -- tree_size of the audit_merkle_roots row that covers to_audit_id
    -- at export time. Verifiers fetch the corresponding root and walk
    -- the chain back through the exported rows.
    tree_size_at_export bigint NOT NULL DEFAULT 0,
    -- Merkle root hash + KMS signature of the canonical export bytes
    -- (manifest JSON minus the signature field itself). Same kid the
    -- audit_merkle_roots row uses — verifiers fetch JWKS by kid.
    root_hash         bytea NOT NULL,
    signature         bytea,
    signature_kid     text,
    -- Free-form actor label (mirrors audit_log.actor_label semantics).
    exported_by       text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, export_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_export_manifests_tenant
    ON audit_export_manifests (tenant_id, created_at DESC);

GRANT SELECT, INSERT ON audit_export_manifests TO postwave_app;

ALTER TABLE audit_export_manifests ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON audit_export_manifests
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
