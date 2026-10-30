-- 0139_maintenance_windows.sql
--
-- Scheduled-maintenance windows that publish to the status page +
-- notify subscribed customers in advance.
--
-- Operators schedule the window via /api/v1/maintenance-windows
-- POST. The status-page handler reads `is_active` (now BETWEEN
-- starts_at AND ends_at) to surface a "scheduled maintenance"
-- banner. A separate worker emails status_subscribers when:
--
--   * 7 days before starts_at (advance notice).
--   * 1 hour before starts_at (heads-up).
--   * Status flips to "in progress" + "completed".
--
-- Cross-platform: the status-page banner pulls from this same
-- table; no separate "current status" notion. Operators editing a
-- live banner reuse the CRUD they already used to schedule it.

BEGIN;

CREATE TABLE IF NOT EXISTS maintenance_windows (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL tenant_id = platform-wide maintenance (status.postwave.com).
    -- Per-tenant entries are filtered to that tenant's status page.
    tenant_id     uuid,
    title         text NOT NULL,
    description   text NOT NULL DEFAULT '',
    -- Comma-separated component names (e.g. "api,workers"). Free-form
    -- so deployments can declare their own component taxonomy
    -- without a schema change.
    components    text[] NOT NULL DEFAULT ARRAY[]::text[],
    starts_at     timestamptz NOT NULL,
    ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
    status        text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
    -- Notify flags drive the per-window emailer. Operators
    -- override the global defaults per window when they want.
    notify_7d_at  timestamptz,  -- stamped when the 7-day email goes out
    notify_1h_at  timestamptz,
    notify_started_at   timestamptz,
    notify_completed_at timestamptz,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_active
    ON maintenance_windows (starts_at, ends_at)
    WHERE status IN ('scheduled','in_progress');

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_tenant
    ON maintenance_windows (tenant_id, starts_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON maintenance_windows TO postwave_app;

-- RLS: per-tenant rows visible to that tenant; platform-wide (NULL
-- tenant_id) visible to everyone. The status-page handler reads
-- this directly; the admin CRUD writes only its own tenant.
ALTER TABLE maintenance_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON maintenance_windows AS PERMISSIVE FOR ALL TO postwave_app
    USING (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      OR tenant_id IS NULL
      OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
