-- 0390_audit_export_schedules.sql
--
-- feat/full-surface-wiring: scheduled evidence packs.
--
-- Compliance teams want a recurring audit-trail export ("evidence
-- pack") landing in their inbox weekly/monthly instead of remembering
-- to click Export. This migration adds:
--
--   1. `audit_export_schedules` — per-tenant cadence config
--      (weekly | monthly) + recipient list + optional stored filter
--      set. The schedule worker (handlers/audit_export_schedules.go)
--      enqueues a regular audit_export_jobs row when a schedule is
--      due, so the evidence pack flows through the EXACT same async
--      export pipeline operators use interactively.
--
--   2. Two columns on `audit_export_jobs`:
--        * schedule_id — provenance link back to the schedule that
--          enqueued the job (NULL for interactive exports).
--        * notified_at — set once the schedule worker has emailed the
--          download link to the recipients, so a job is never
--          announced twice.
--
--   3. Worker gates. Both the schedule due-scan and the
--      completed-job notification scan are cross-tenant background
--      reads, and the export worker's claim/heartbeat runs outside a
--      tenant binding, so both tables get the app.outbox_worker OR
--      (mirroring 0383 referral_conversions_worker_select /
--      1708 tenant_worker_select). audit_export_jobs additionally
--      needs the worker in WITH CHECK because the claim UPDATE
--      (pending → in_progress) runs under worker scope. The worker
--      GUC is only ever bound by trusted background code paths
--      (db.WithWorkerScope), never by request traffic.
--
-- RLS: canonical NULLIF idiom throughout.
--
-- rollback-strategy: DROP TABLE audit_export_schedules; ALTER TABLE
-- audit_export_jobs DROP COLUMN schedule_id, DROP COLUMN notified_at;
-- recreate the 0307 policies. Additive change — previous releases
-- never read these columns.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_export_schedules (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cadence          TEXT NOT NULL CHECK (cadence IN ('weekly','monthly')),
    -- Email recipients for the "your evidence pack is ready" mail.
    recipients       TEXT[] NOT NULL CHECK (array_length(recipients, 1) >= 1),
    -- Same opaque filter shape audit_export_jobs.filters_json uses;
    -- copied verbatim onto each enqueued job.
    filters_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled          BOOLEAN NOT NULL DEFAULT true,
    created_by       UUID,
    created_by_email TEXT,
    last_enqueued_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_export_schedules_tenant_idx
    ON audit_export_schedules (tenant_id, created_at DESC);

-- Due-scan support: enabled schedules ordered by how stale they are.
CREATE INDEX IF NOT EXISTS audit_export_schedules_due_idx
    ON audit_export_schedules (last_enqueued_at ASC NULLS FIRST)
    WHERE enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_export_schedules TO postwave_app;

ALTER TABLE audit_export_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_export_schedules FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_export_schedules
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON audit_export_schedules
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Read-only gate for the cross-tenant due/notify scans. Writes stay
-- tenant-scoped (the worker re-enters db.WithTenant per schedule).
CREATE POLICY worker_select ON audit_export_schedules
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------
-- audit_export_jobs: provenance + notification bookkeeping columns.
-- ---------------------------------------------------------------

ALTER TABLE audit_export_jobs
    ADD COLUMN IF NOT EXISTS schedule_id UUID
        REFERENCES audit_export_schedules(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Widen the 0307 policies for the export worker. The claim UPDATE
-- (pending → in_progress, cross-tenant FOR UPDATE SKIP LOCKED) and
-- the heartbeat/complete/fail updates run under app.outbox_worker
-- without a tenant binding, so both USING and WITH CHECK need the
-- worker OR. tenant_id itself is immutable on those updates.
DROP POLICY IF EXISTS tenant_isolation ON audit_export_jobs;
CREATE POLICY tenant_isolation ON audit_export_jobs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

DROP POLICY IF EXISTS worker_all ON audit_export_jobs;
CREATE POLICY worker_all ON audit_export_jobs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMIT;

-- Notification scan: completed scheduled jobs not yet announced.
-- OUTSIDE the transaction — audit_export_jobs already exists with
-- live writers, so the index build must be CONCURRENTLY, and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction (the
-- migration runner executes each statement standalone; see the
-- 0166 deploy notes for the established pattern).
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_export_jobs_schedule_notify_idx
    ON audit_export_jobs (completed_at)
    WHERE schedule_id IS NOT NULL AND status = 'completed' AND notified_at IS NULL;
