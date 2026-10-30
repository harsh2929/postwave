-- 0271_audit_retention.sql
--
-- Retention-trail-archive feature (Compliance, P1):
--
--   1. Per-row retention overrides on audit_log:
--        retention_override_days  — nullable int; overrides the tenant
--                                   default for this single row.
--        legal_hold               — bool; when true the row is exempt
--                                   from the trim worker entirely.
--
--   2. Carve-out for audit.retention.purge events — purge events emitted
--      by the trim worker are themselves never purged. Enforced in the
--      trim query (apps/api/internal/audit/trim.go trimBatch) rather
--      than via a trigger so an operator can read the carve-out by
--      reading the worker code; the index below keeps the predicate
--      cheap.
--
--   3. Parquet archive sink configuration column on audit_sinks:
--        parquet_config jsonb — bucket / prefix / retention_days /
--        object_lock_mode (COMPLIANCE | GOVERNANCE) / object_lock_legal_hold.
--      The 'archive' sink kind is added to the existing kind CHECK
--      constraint so the admin endpoint can validate it.
--
--   4. View audit_retention_purge_events — what the Compliance page
--      "Retention activity" tab reads from. RLS via the standard
--      NULLIF(current_setting('app.tenant_id', true), '')::uuid idiom.

BEGIN;

-- 1. audit_log per-row retention overrides.

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS retention_override_days int,
    ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;

-- Cap retention overrides to a sane 1..3650 range when set. NULL is
-- always legal (means "use tenant default").
ALTER TABLE audit_log
    DROP CONSTRAINT IF EXISTS audit_log_retention_override_range;
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_retention_override_range
        CHECK (retention_override_days IS NULL
               OR (retention_override_days >= 1
                   AND retention_override_days <= 3650));

-- Index on legal_hold so the trim WHERE clause can skip held rows
-- without a full scan. Partial index — most rows are not held.
CREATE INDEX IF NOT EXISTS idx_audit_log_legal_hold_tenant
    ON audit_log (tenant_id, at DESC)
    WHERE legal_hold = true;

-- Index on action so the trim carve-out for 'audit.retention.purge'
-- doesn't scan the table.
CREATE INDEX IF NOT EXISTS idx_audit_log_action_tenant
    ON audit_log (tenant_id, action);

-- 2. audit_sinks: extend the kind CHECK to allow 'archive'.

ALTER TABLE audit_sinks
    DROP CONSTRAINT IF EXISTS audit_sinks_kind_check;
ALTER TABLE audit_sinks
    ADD CONSTRAINT audit_sinks_kind_check
        CHECK (kind IN ('s3', 'datadog', 'splunk', 'http', 'archive'));

-- Per-kind config column for the parquet archive sink. NULL for any
-- non-archive sink. JSON shape:
--   {
--     "bucket": "postwave-audit-archive",
--     "prefix": "audit",
--     "retention_days": 2555,           -- 7-year default per SOC 2
--     "object_lock_mode": "COMPLIANCE", -- or "GOVERNANCE"
--     "object_lock_legal_hold": false
--   }
ALTER TABLE audit_sinks
    ADD COLUMN IF NOT EXISTS parquet_config jsonb;

-- 3. Retention-activity view. Reads only audit.retention.purge events
--    for the calling tenant. The trim worker writes one row per batch
--    via app.audit_internal_writer so the immutability trigger lets
--    them through.
CREATE OR REPLACE VIEW audit_retention_purge_events AS
SELECT
    id,
    tenant_id,
    action,
    metadata->>'deleted_id_range'           AS deleted_id_range,
    (metadata->>'deleted_count')::int       AS deleted_count,
    (metadata->>'retention_days')::int      AS retention_days,
    metadata->>'before_root_hash'           AS before_root_hash,
    at
FROM audit_log
WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND action = 'audit.retention.purge'
ORDER BY at DESC;

GRANT SELECT ON audit_retention_purge_events TO postwave_app;

-- 4. Re-install the immutability guard so retention_override_days +
--    legal_hold writes through the standard app role are allowed even
--    though the row is otherwise append-only. We extend the OLD-row
--    check so any UPDATE that only touches retention_override_days,
--    legal_hold, or updated_at is permitted; everything else still
--    raises. The Merkle backfill worker remains exempt via the
--    existing app.audit_internal_writer GUC.
CREATE OR REPLACE FUNCTION audit_log_immutability_guard()
RETURNS trigger AS $$
BEGIN
    IF current_setting('app.audit_internal_writer', true) = 'true' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'DELETE' AND current_setting('app.audit_trim_worker', true) = 'true' THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- Only retention_override_days + legal_hold may be flipped on
        -- a per-row basis via the standard app role. Everything else
        -- (action, metadata, hashes, actor, etc.) is immutable.
        IF NEW.id = OLD.id
           AND NEW.tenant_id = OLD.tenant_id
           AND NEW.action = OLD.action
           AND NEW.at = OLD.at
           AND COALESCE(NEW.metadata::text, '') = COALESCE(OLD.metadata::text, '')
           AND COALESCE(NEW.row_hash, ''::bytea) = COALESCE(OLD.row_hash, ''::bytea)
           AND COALESCE(NEW.prev_hash, ''::bytea) = COALESCE(OLD.prev_hash, ''::bytea)
           AND COALESCE(NEW.actor_type, '') = COALESCE(OLD.actor_type, '')
           AND COALESCE(NEW.actor_label, '') = COALESCE(OLD.actor_label, '')
        THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only (op=%); set app.audit_internal_writer or app.audit_trim_worker GUC to bypass, or update only retention_override_days/legal_hold', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- Granted back UPDATE on the table so the override + legal_hold path
-- can compile. The trigger still enforces append-only on every other
-- column. REVOKE in 0169 was belt-and-suspenders; the trigger remains
-- the load-bearing defence.
GRANT UPDATE (retention_override_days, legal_hold) ON audit_log TO postwave_app;

COMMIT;
