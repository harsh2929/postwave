-- Build indexes added by migrations 1711, 1713, and 1714 without taking a
-- conventional index-build lock on existing customer-data tables.
--
-- This file MUST NOT be wrapped in BEGIN/COMMIT: PostgreSQL forbids
-- CONCURRENTLY inside a transaction block. Every statement is idempotent so
-- the migration runner can safely retry after a process or database failure
-- between statements.

CREATE INDEX CONCURRENTLY IF NOT EXISTS form_file_uploads_orphan_cleanup_idx
    ON form_file_uploads (uploaded_at, id)
    WHERE submission_id IS NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_portal_sessions_cookie_token
    ON audit_portal_sessions (session_token_hash)
    WHERE session_token_hash IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_portal_sessions_unexchanged
    ON audit_portal_sessions (tenant_id, expires_at)
    WHERE exchanged_at IS NULL AND revoked_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS form_file_uploads_quarantine_scan_idx
    ON form_file_uploads (scan_next_attempt_at, id)
    WHERE submission_id IS NOT NULL
      AND scan_status IN ('pending','quarantined');

CREATE INDEX CONCURRENTLY IF NOT EXISTS form_file_uploads_rejected_cleanup_idx
    ON form_file_uploads (scanned_at, id)
    WHERE scan_status IN ('infected','rejected','error')
      AND object_deleted_at IS NULL;
