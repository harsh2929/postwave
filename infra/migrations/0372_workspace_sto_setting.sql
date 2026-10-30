-- 0372_workspace_sto_setting.sql
--
-- Workspace-level send-time-optimization toggle (desktop gap A24).
--
-- The desktop's SendTime page has carried a *device-local* STO toggle
-- (localStorage) because no tenant-level setting existed. This adds the
-- boolean to tenant_send_settings — the table 0299 created precisely to
-- carry tenant-level send defaults (default_sto_strategy,
-- newsletters_force_per_recipient) — rather than minting a new table.
--
-- Default TRUE mirrors the desktop's default-on behaviour
-- (readStoEnabled() returns true when the localStorage key is absent),
-- so existing tenants see no behaviour change when the UI switches from
-- the device-local flag to this workspace setting.
--
-- Exposed via GET/PUT /api/v1/settings/send-time-optimization
-- (apps/api/internal/settings/send_time_optimization.go). The flag is
-- the workspace source of truth for the UI; server-side STO application
-- remains operator-driven (POST /campaigns/{id}/schedule-by-best-time).
--
-- RLS: tenant_send_settings already has FORCE RLS + the standard
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid policies
-- from 0299 — a column addition inherits them.
--
-- Rollback:
--   ALTER TABLE tenant_send_settings
--     DROP COLUMN IF EXISTS send_time_optimization_enabled;

BEGIN;

ALTER TABLE tenant_send_settings
    ADD COLUMN IF NOT EXISTS send_time_optimization_enabled boolean NOT NULL DEFAULT true;

COMMIT;
