-- 0169_audit_log_immutability.sql
--
-- Closes the audit-log immutability gap documented in the audit-log
-- audit (HIGH #1): the application role `postwave_app` was granted
-- only SELECT + INSERT on audit_log, but the trigger-level
-- enforcement was absent. A future migration that issued `GRANT
-- ALL` (a pattern present elsewhere in the schema) would silently
-- open UPDATE/DELETE without breaking any code paths — and any
-- direct psql access by a DB admin can already modify rows. The
-- BEFORE UPDATE/DELETE trigger raises an exception immediately,
-- making tampering loud rather than silent.
--
-- The trigger is bypassed by `app.audit_internal_writer = 'true'`
-- so the Merkle-chain backfill worker (which legitimately UPDATEs
-- row_hash + prev_hash on freshly-inserted rows) can do its job.
-- The trimmer is similarly let through via `app.audit_trim_worker`
-- — both GUCs are set explicitly by the workers, not by request-
-- path code, so a leaked-creds attacker can't bypass.
--
-- Also fixes audit_log audit CRITICAL #2: the retention trimmer
-- referenced a non-existent `created_at` column. The actual column
-- is `at`. Rather than rewrite the trimmer's SQL (Go code change),
-- add a generated alias `created_at` so both names work — backward-
-- compatible if any external dashboards / scripts reference the
-- old name.

BEGIN;

-- Generated column alias so any code referencing `created_at` keeps
-- working. Cheap (just a projection of `at`) and idempotent.
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS created_at timestamptz
        GENERATED ALWAYS AS (at) STORED;

-- Trigger function: raise on UPDATE/DELETE unless an explicit
-- worker GUC says otherwise. STRICT + IMMUTABLE so the planner
-- knows it's safe to inline.
CREATE OR REPLACE FUNCTION audit_log_immutability_guard()
RETURNS trigger AS $$
BEGIN
    -- Allow the Merkle backfill worker to UPDATE row_hash/prev_hash
    -- on freshly-inserted rows.
    IF current_setting('app.audit_internal_writer', true) = 'true' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    -- Allow the retention trimmer to DELETE rows past their
    -- retention window.
    IF TG_OP = 'DELETE' AND current_setting('app.audit_trim_worker', true) = 'true' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only (op=%); set app.audit_internal_writer or app.audit_trim_worker GUC to bypass', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION audit_log_immutability_guard();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION audit_log_immutability_guard();

-- Belt-and-suspenders: revoke UPDATE/DELETE on the table from the
-- app role. Even if a future migration grants ALL, the trigger
-- still fires; even if the trigger is dropped, the role-level
-- privilege denial still blocks. Two layers.
REVOKE UPDATE, DELETE ON audit_log FROM postwave_app;

COMMIT;
