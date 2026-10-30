-- 1838_reputation_alerts.sql
--
-- INBOX-036 — subscribe-to-alerts for blocklist hits and reputation drops. The
-- reputation trend (INBOX-031, reputation_snapshots) already accrues one row
-- per fetch. A background worker in apps/api scans that series for un-alerted
-- transitions (a new blocklist hit, a SenderScore fall, or a provider bucket
-- dropping to 'low') and fans a notification out to the tenant's operators via
-- the shared notifyfanout chokepoint, gated by an opt-in preference.
--
-- Two additive changes:
--   1. reputation_snapshots.alerted_at — marks a snapshot as processed by the
--      alert worker (NULL = pending), so each transition alerts at most once.
--      The worker scans cross-tenant, so the tenant_isolation policy gains the
--      standard app.outbox_worker escape (mirroring notification_feed).
--   2. notification_preferences.email_on_deliverability_alert — the per-user
--      opt-in the notifyfanout Pref gate honors. Defaults true (high-signal,
--      time-sensitive; the user can opt out), matching email_on_bounce_alert.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive columns + a widened (superset) RLS policy + an
-- index. Older code never reads alerted_at and the policy only ADDS a worker
-- escape, so a rollback is safe.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE reputation_snapshots
    ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

-- The alert worker (running as the non-owner postwave_app role) stamps
-- alerted_at; 1836 granted only SELECT/INSERT/DELETE, so without this the
-- worker's UPDATE fails with 42501 and never makes progress. Column-scoped for
-- least privilege — the worker only ever writes alerted_at.
GRANT UPDATE (alerted_at) ON reputation_snapshots TO postwave_app;

-- Widen tenant_isolation with the worker escape so the cross-tenant alert
-- scanner (running under app.outbox_worker via db.WithWorkerScope) can read
-- every tenant's series and stamp alerted_at. Tenant reads are unchanged.
DROP POLICY IF EXISTS tenant_isolation ON reputation_snapshots;
CREATE POLICY tenant_isolation ON reputation_snapshots
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS email_on_deliverability_alert boolean NOT NULL DEFAULT true;

COMMIT;

-- Hot path for the worker: the pending (un-alerted) snapshots. Built
-- CONCURRENTLY since reputation_snapshots is an online table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reputation_snapshots_pending_alert_idx
    ON reputation_snapshots (tenant_id, checked_at)
    WHERE alerted_at IS NULL;
