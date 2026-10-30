-- 1804_scheduled_report_delivery_receipts.sql
--
-- Scheduled report delivery used to release its row lock before contacting
-- the mail provider. Two replicas could therefore send the same occurrence,
-- and a process crash after provider acceptance but before last_run_at was
-- persisted caused an automatic resend on the next tick.
--
-- Runs are now immutable occurrence-time snapshots. Per-recipient receipts
-- cross a committed `sending` boundary before the network call. A worker may
-- recover an expired queued/rendering lease, but an expired `sending` receipt
-- is deliberately terminal `unknown`: provider acceptance cannot be inferred
-- after a crash and the system must never trade uncertainty for a duplicate.
--
-- rollback-strategy: expand-contract
-- rollback-details: retain delivery evidence; older binaries ignore the new
--                   tables but must not be promoted after this migration.
-- migration-execution: phased

-- A redundant composite identity lets the run FK prove that its definition
-- belongs to the same tenant. Referential-integrity checks are not an RLS
-- boundary, so two independent single-column FKs would be insufficient.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    scheduled_reports_tenant_id_id_uidx
    ON scheduled_reports (tenant_id, id);

BEGIN;

-- Keep the legacy cursor physically empty after this point. Release
-- migrations run before the API's 100/200 ECS rolling replacement, so an old
-- worker can otherwise overlap a new worker and send the same occurrence.
-- Old API writes are redirected into the durable cursor by the trigger; old
-- workers only read next_due_at and therefore fail safely closed. A full code
-- rollback pauses scheduled delivery instead of reviving the unsafe sender.
ALTER TABLE scheduled_reports
    ADD COLUMN IF NOT EXISTS delivery_next_due_at timestamptz;

UPDATE scheduled_reports
   SET delivery_next_due_at =
           COALESCE(delivery_next_due_at, next_due_at),
       next_due_at = NULL
 WHERE next_due_at IS NOT NULL;

CREATE OR REPLACE FUNCTION redirect_legacy_scheduled_report_cursor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.delivery_next_due_at :=
            COALESCE(NEW.delivery_next_due_at, NEW.next_due_at);
    ELSE
        -- An UPDATE that explicitly names the legacy cursor is an old-binary
        -- write. Preserve NULL as a deliberate pause as well as timestamps.
        NEW.delivery_next_due_at := NEW.next_due_at;
    END IF;
    NEW.next_due_at := NULL;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduled_reports_legacy_cursor_redirect
    ON scheduled_reports;
CREATE TRIGGER scheduled_reports_legacy_cursor_redirect
    BEFORE INSERT OR UPDATE OF next_due_at ON scheduled_reports
    FOR EACH ROW
    EXECUTE FUNCTION redirect_legacy_scheduled_report_cursor();

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    scheduled_reports_delivery_due_idx
    ON scheduled_reports (delivery_next_due_at, tenant_id, id)
    WHERE enabled = true AND delivery_next_due_at IS NOT NULL;

BEGIN;

-- Legacy worker errors embedded recipient addresses plus raw provider text.
-- Replace them once, then keep the compatibility summary column bounded.
UPDATE scheduled_reports
   SET last_run_error =
       'A previous delivery failed before durable delivery receipts were enabled.'
 WHERE last_run_error IS NOT NULL;

ALTER TABLE scheduled_reports
    DROP CONSTRAINT IF EXISTS scheduled_reports_last_run_error_bounds;
ALTER TABLE scheduled_reports
    ADD CONSTRAINT scheduled_reports_last_run_error_bounds
    CHECK (
        last_run_error IS NULL
        OR octet_length(last_run_error) <= 512
    ) NOT VALID;
ALTER TABLE scheduled_reports
    VALIDATE CONSTRAINT scheduled_reports_last_run_error_bounds;

ALTER TABLE scheduled_reports
    ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE scheduled_reports
    DROP CONSTRAINT IF EXISTS scheduled_reports_timezone_bounds;
ALTER TABLE scheduled_reports
    ADD CONSTRAINT scheduled_reports_timezone_bounds
    CHECK (
        octet_length(timezone) BETWEEN 1 AND 64
        AND timezone !~ '[[:cntrl:]]'
    ) NOT VALID;
ALTER TABLE scheduled_reports
    VALIDATE CONSTRAINT scheduled_reports_timezone_bounds;

CREATE TABLE IF NOT EXISTS scheduled_report_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- SET NULL preserves the occurrence snapshot/history when an operator
    -- deletes the recurring definition.
    scheduled_report_id     uuid,
    scheduled_report_id_snapshot uuid NOT NULL,
    run_kind                text NOT NULL
                                CHECK (run_kind IN ('recurring', 'manual')),
    occurrence_at           timestamptz NOT NULL,
    idempotency_key_hash    bytea,
    report_name_snapshot    text NOT NULL,
    template_snapshot       text NOT NULL,
    schedule_snapshot       text NOT NULL,
    timezone_snapshot       text NOT NULL,
    status                  text NOT NULL DEFAULT 'queued'
                                CHECK (status IN
                                    ('queued', 'leased', 'delivering', 'succeeded',
                                     'partial', 'failed', 'needs_review')),
    lease_owner             text,
    lease_expires_at        timestamptz,
    attempt_count           integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    period_start_at         timestamptz,
    period_end_at           timestamptz,
    metrics_snapshot        jsonb,
    subject_snapshot        text,
    body_snapshot           text,
    last_error_code         text,
    last_error_summary      text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    retention_until         timestamptz NOT NULL
                                DEFAULT (now() + interval '90 days'),
    started_at              timestamptz,
    rendered_at             timestamptz,
    completed_at            timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_report_runs_tenant_identity UNIQUE (tenant_id, id),
    CONSTRAINT scheduled_report_runs_report_tenant_fkey
        FOREIGN KEY (tenant_id, scheduled_report_id)
        REFERENCES scheduled_reports (tenant_id, id)
        ON DELETE SET NULL (scheduled_report_id),
    CONSTRAINT scheduled_report_runs_idempotency_shape CHECK (
        (
            run_kind = 'manual'
            AND idempotency_key_hash IS NOT NULL
            AND octet_length(idempotency_key_hash) = 32
        )
        OR
        (
            run_kind = 'recurring'
            AND idempotency_key_hash IS NULL
        )
    ),
    CONSTRAINT scheduled_report_runs_report_identity_shape CHECK (
        scheduled_report_id IS NULL
        OR scheduled_report_id = scheduled_report_id_snapshot
    ),
    CONSTRAINT scheduled_report_runs_snapshot_bounds CHECK (
        octet_length(report_name_snapshot) BETWEEN 1 AND 160
        AND octet_length(template_snapshot) BETWEEN 1 AND 64
        AND octet_length(schedule_snapshot) BETWEEN 1 AND 80
        AND octet_length(timezone_snapshot) BETWEEN 1 AND 64
        AND timezone_snapshot !~ '[[:cntrl:]]'
        AND (subject_snapshot IS NULL OR octet_length(subject_snapshot) <= 998)
        AND (body_snapshot IS NULL OR octet_length(body_snapshot) <= 131072)
        AND (metrics_snapshot IS NULL OR jsonb_typeof(metrics_snapshot) = 'object')
        AND (last_error_code IS NULL OR octet_length(last_error_code) <= 64)
        AND (last_error_summary IS NULL OR octet_length(last_error_summary) <= 512)
        AND retention_until > created_at
    ),
    CONSTRAINT scheduled_report_runs_lease_shape CHECK (
        (
            status IN ('leased', 'delivering')
            AND NULLIF(btrim(lease_owner), '') IS NOT NULL
            AND lease_expires_at IS NOT NULL
        )
        OR
        (
            status NOT IN ('leased', 'delivering')
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
        )
    ),
    CONSTRAINT scheduled_report_runs_completion_shape CHECK (
        (
            status IN ('succeeded', 'partial', 'failed', 'needs_review')
            AND completed_at IS NOT NULL
        )
        OR
        (
            status IN ('queued', 'leased', 'delivering')
            AND completed_at IS NULL
        )
    ),
    CONSTRAINT scheduled_report_runs_render_shape CHECK (
        (
            rendered_at IS NULL
            AND period_start_at IS NULL
            AND period_end_at IS NULL
            AND metrics_snapshot IS NULL
            AND subject_snapshot IS NULL
            AND body_snapshot IS NULL
        )
        OR
        (
            rendered_at IS NOT NULL
            AND period_start_at IS NOT NULL
            AND period_end_at IS NOT NULL
            AND period_start_at < period_end_at
            AND metrics_snapshot IS NOT NULL
            AND subject_snapshot IS NOT NULL
            AND body_snapshot IS NOT NULL
        )
    )
);

CREATE TABLE IF NOT EXISTS scheduled_report_delivery_receipts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id                  uuid NOT NULL,
    recipient               text NOT NULL,
    recipient_hash          bytea NOT NULL,
    recipient_ordinal       integer NOT NULL CHECK (recipient_ordinal >= 0),
    state                   text NOT NULL DEFAULT 'pending'
                                CHECK (state IN
                                    ('pending', 'sending', 'accepted', 'failed',
                                     'unknown', 'skipped')),
    lease_owner             text,
    lease_expires_at        timestamptz,
    attempt_count           integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
    provider_receipt        text,
    error_code              text,
    error_summary           text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    sending_started_at      timestamptz,
    accepted_at             timestamptz,
    completed_at            timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_report_delivery_receipts_run_fkey
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES scheduled_report_runs (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT scheduled_report_delivery_receipts_identity
        UNIQUE (run_id, recipient_hash),
    CONSTRAINT scheduled_report_delivery_receipts_bounds CHECK (
        octet_length(recipient) BETWEEN 3 AND 320
        AND octet_length(recipient_hash) = 32
        AND (provider_receipt IS NULL OR octet_length(provider_receipt) <= 512)
        AND (error_code IS NULL OR octet_length(error_code) <= 64)
        AND (error_summary IS NULL OR octet_length(error_summary) <= 512)
    ),
    CONSTRAINT scheduled_report_delivery_receipts_lease_shape CHECK (
        (
            state = 'sending'
            AND NULLIF(btrim(lease_owner), '') IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND sending_started_at IS NOT NULL
            AND attempt_count = 1
        )
        OR
        (
            state <> 'sending'
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
        )
    ),
    CONSTRAINT scheduled_report_delivery_receipts_completion_shape CHECK (
        (
            state = 'pending'
            AND completed_at IS NULL
            AND accepted_at IS NULL
            AND sending_started_at IS NULL
            AND attempt_count = 0
        )
        OR
        (
            state = 'sending'
            AND completed_at IS NULL
            AND accepted_at IS NULL
        )
        OR
        (
            state = 'accepted'
            AND completed_at IS NOT NULL
            AND accepted_at IS NOT NULL
            AND attempt_count = 1
        )
        OR
        (
            state IN ('failed', 'unknown')
            AND completed_at IS NOT NULL
            AND accepted_at IS NULL
            AND attempt_count = 1
        )
        OR
        (
            state = 'skipped'
            AND completed_at IS NOT NULL
            AND accepted_at IS NULL
            AND sending_started_at IS NULL
            AND attempt_count = 0
        )
    )
);

-- One durable row owns a scheduled occurrence across every replica.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_report_runs_occurrence_uidx
    ON scheduled_report_runs (
        tenant_id,
        scheduled_report_id_snapshot,
        occurrence_at
    )
    WHERE run_kind = 'recurring';

-- Retries of one send-now request return the original frozen run.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_report_runs_manual_idempotency_uidx
    ON scheduled_report_runs
        (tenant_id, scheduled_report_id_snapshot, idempotency_key_hash)
    WHERE run_kind = 'manual'
      AND idempotency_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS scheduled_report_runs_worker_due_idx
    ON scheduled_report_runs (
        COALESCE(lease_expires_at, created_at),
        created_at,
        id
    )
    WHERE status IN ('queued', 'leased', 'delivering');

CREATE INDEX IF NOT EXISTS scheduled_report_runs_history_idx
    ON scheduled_report_runs (tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS scheduled_report_runs_retention_idx
    ON scheduled_report_runs (retention_until, id)
    WHERE status IN ('succeeded', 'partial', 'failed', 'needs_review');

CREATE INDEX IF NOT EXISTS scheduled_report_delivery_receipts_run_idx
    ON scheduled_report_delivery_receipts (tenant_id, run_id, recipient_ordinal, id);

CREATE INDEX IF NOT EXISTS scheduled_report_delivery_receipts_ambiguous_idx
    ON scheduled_report_delivery_receipts (lease_expires_at, run_id, id)
    WHERE state = 'sending';

ALTER TABLE scheduled_report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_report_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_report_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_report_delivery_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_report_runs_tenant ON scheduled_report_runs;
CREATE POLICY scheduled_report_runs_tenant
ON scheduled_report_runs
FOR ALL
TO postwave_app
USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

DROP POLICY IF EXISTS scheduled_report_runs_worker ON scheduled_report_runs;
CREATE POLICY scheduled_report_runs_worker
ON scheduled_report_runs
FOR ALL
TO postwave_app
USING (
    COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
)
WITH CHECK (
    COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
);

DROP POLICY IF EXISTS scheduled_report_delivery_receipts_tenant
    ON scheduled_report_delivery_receipts;
CREATE POLICY scheduled_report_delivery_receipts_tenant
ON scheduled_report_delivery_receipts
FOR ALL
TO postwave_app
USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);

DROP POLICY IF EXISTS scheduled_report_delivery_receipts_worker
    ON scheduled_report_delivery_receipts;
CREATE POLICY scheduled_report_delivery_receipts_worker
ON scheduled_report_delivery_receipts
FOR ALL
TO postwave_app
USING (
    COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
)
WITH CHECK (
    COALESCE(current_setting('app.outbox_worker', true), '') = 'true'
);

GRANT SELECT, INSERT, UPDATE, DELETE
ON scheduled_report_runs, scheduled_report_delivery_receipts
TO postwave_app;

-- Snapshot identity is immutable. Lifecycle fields may advance, and the
-- report FK may become NULL only through ON DELETE SET NULL.
CREATE OR REPLACE FUNCTION guard_scheduled_report_run_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.scheduled_report_id IS NULL
           OR NEW.scheduled_report_id IS DISTINCT FROM
              NEW.scheduled_report_id_snapshot
        THEN
            RAISE EXCEPTION
                'scheduled report run requires a live tenant-bound definition';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR (
           NEW.scheduled_report_id IS DISTINCT FROM OLD.scheduled_report_id
           AND NOT (
               OLD.scheduled_report_id IS NOT NULL
               AND NEW.scheduled_report_id IS NULL
           )
       )
       OR NEW.scheduled_report_id_snapshot IS DISTINCT FROM
          OLD.scheduled_report_id_snapshot
       OR NEW.run_kind IS DISTINCT FROM OLD.run_kind
       OR NEW.occurrence_at IS DISTINCT FROM OLD.occurrence_at
       OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
       OR NEW.report_name_snapshot IS DISTINCT FROM OLD.report_name_snapshot
       OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot
       OR NEW.schedule_snapshot IS DISTINCT FROM OLD.schedule_snapshot
       OR NEW.timezone_snapshot IS DISTINCT FROM OLD.timezone_snapshot
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
       OR (
           OLD.rendered_at IS NOT NULL
           AND (
               NEW.rendered_at IS DISTINCT FROM OLD.rendered_at
               OR NEW.period_start_at IS DISTINCT FROM OLD.period_start_at
               OR NEW.period_end_at IS DISTINCT FROM OLD.period_end_at
               OR NEW.metrics_snapshot IS DISTINCT FROM OLD.metrics_snapshot
               OR NEW.subject_snapshot IS DISTINCT FROM OLD.subject_snapshot
               OR NEW.body_snapshot IS DISTINCT FROM OLD.body_snapshot
           )
       )
    THEN
        RAISE EXCEPTION 'scheduled report run snapshot is immutable';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduled_report_run_snapshot_guard
    ON scheduled_report_runs;
CREATE TRIGGER scheduled_report_run_snapshot_guard
    BEFORE INSERT OR UPDATE ON scheduled_report_runs
    FOR EACH ROW
    EXECUTE FUNCTION guard_scheduled_report_run_snapshot();

CREATE OR REPLACE FUNCTION guard_scheduled_report_delivery_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.recipient IS DISTINCT FROM OLD.recipient
       OR NEW.recipient_hash IS DISTINCT FROM OLD.recipient_hash
       OR NEW.recipient_ordinal IS DISTINCT FROM OLD.recipient_ordinal
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'scheduled report delivery snapshot is immutable';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scheduled_report_delivery_snapshot_guard
    ON scheduled_report_delivery_receipts;
CREATE TRIGGER scheduled_report_delivery_snapshot_guard
    BEFORE UPDATE ON scheduled_report_delivery_receipts
    FOR EACH ROW
    EXECUTE FUNCTION guard_scheduled_report_delivery_snapshot();

COMMENT ON TABLE scheduled_report_runs IS
    'Immutable scheduled/manual report occurrence snapshots with leased processing and terminal aggregate truth.';
COMMENT ON TABLE scheduled_report_delivery_receipts IS
    'Per-recipient delivery evidence; expired sending is terminal unknown and is never automatically retried.';

COMMIT;
