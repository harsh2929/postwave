-- 0270_audit_session_link.sql
--
-- Session-replay deep-link integration (audit-2026 UX, P1).
--
-- Extends audit_log with two columns:
--
--   session_id        text  — cookie-derived session identifier (the
--                              browser session that produced the action;
--                              NULL for system/agent actors).
--   client_event_seq  int   — monotonically incrementing counter the SPA
--                              sends with each UI action via the
--                              X-Postwave-Event-Seq header; lets us order
--                              events inside a session even when their
--                              `at` timestamps collide at the millisecond.
--
-- Together these power GET /api/v1/audit/{id}/session-replay → a replay
-- URL scoped ±2min around the audit event so an investigator can watch
-- the operator's actual mouse movements that produced the row.
--
-- RLS continues to use the existing tenant_isolation policy on
-- audit_log; the NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- idiom already gates row visibility regardless of which columns are
-- read, so no policy changes are required for the new columns.

BEGIN;

-- Add the two new columns. Default null so historical rows remain valid
-- without a backfill; the lookup endpoint returns "not_available" when
-- session_id is null on the requested row.
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS session_id text,
    ADD COLUMN IF NOT EXISTS client_event_seq integer;

-- Partial index: only audit rows that actually carry a session_id pay
-- the index cost. The common path "show me every UI action in session
-- X for tenant T" becomes a single index scan.
CREATE INDEX IF NOT EXISTS audit_log_tenant_session_idx
    ON audit_log (tenant_id, session_id)
    WHERE session_id IS NOT NULL;

-- Sequential ordering inside a session. The replay player needs events
-- in the seq order the SPA emitted them — `at` alone can tie when two
-- actions land in the same millisecond.
CREATE INDEX IF NOT EXISTS audit_log_session_seq_idx
    ON audit_log (tenant_id, session_id, client_event_seq DESC)
    WHERE session_id IS NOT NULL;

COMMIT;
