-- 0311_sto_quiet_hours_edge_snap.sql
--
-- sto-quiet-hours-edge-snap (P1, surface=send-time).
--
-- BEFORE this migration, Postwave's send-time-optimization pipeline
-- (send_time_opt/) projects a per-subscriber best_send_hour 0..167 and
-- schedules the next send at that hour. If a recipient's best hour
-- falls inside a "quiet" window — e.g. their modal opens are at 5:30am
-- because they wake early to scroll inbox — Postwave will happily fire
-- the send at 5:00am, which most marketers consider rude (a "first
-- thing in the morning" send is fine; an in-the-middle-of-the-night
-- send breeds spam complaints).
--
-- 2026 SOTA across the ESPs:
--
--   * Braze "Intelligent Timing" snaps an in-window optimal hour to the
--     NEAREST EDGE of the quiet-hours window. 5:30am optimal with a
--     quiet window of 22:00-06:00 → 6:00am send. The "nearest edge"
--     rule means an optimal of 01:00 → 22:00 (yesterday's edge) and an
--     optimal of 04:00 → 06:00 (today's edge).
--   * Iterable defers any in-window send to the WINDOW END (06:00 in
--     the example) — strictly conservative. Maps cleanly to a
--     "defer-to-end" policy.
--   * Klaviyo restricts SMS automatically per TCPA (8am-9pm recipient
--     local) and exposes "smart sending" for email; outside the window
--     the send is skipped (not deferred). Maps to "skip".
--
-- This migration adds the per-tenant settings + the policy enum. The
-- actual snap/defer/skip logic lives in
-- apps/api/internal/send_time_opt/quiet_hours.go so it can be unit-
-- tested without a DB. Migration is non-destructive: existing tenants
-- with no quiet_hours_start / quiet_hours_end set get the legacy
-- behaviour (no quiet hours enforced).
--
-- Columns added to tenant_send_settings:
--
--   * quiet_hours_start  smallint   — hour-of-day 0..23 when quiet
--     window opens (e.g. 22 = 10pm). NULL = no quiet hours.
--   * quiet_hours_end    smallint   — hour-of-day 0..23 when quiet
--     window closes (e.g. 6 = 6am). NULL = no quiet hours.
--     Windows that cross midnight (start > end) are explicitly
--     supported — that's the common case (22 → 6).
--   * quiet_hours_policy text       — 'snap' | 'defer_to_end' | 'skip'.
--     Default 'snap' (Braze-style nearest-edge), since this is the
--     least disruptive policy: the send still goes out the same day,
--     just shifted to a polite hour.
--
-- The columns piggyback on the existing tenant_send_settings table
-- (created in 0299_sto_strategy_persistence.sql, with RLS + grants
-- already wired). No new RLS policy is needed because we're only
-- adding columns.

BEGIN;

ALTER TABLE tenant_send_settings
    ADD COLUMN IF NOT EXISTS quiet_hours_start  smallint,
    ADD COLUMN IF NOT EXISTS quiet_hours_end    smallint,
    ADD COLUMN IF NOT EXISTS quiet_hours_policy text NOT NULL DEFAULT 'snap';

-- Range check on the start/end hour-of-day. NULL is allowed (means "no
-- quiet hours"); when set, both must be 0..23.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_quiet_hours_start_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_quiet_hours_start_chk
            CHECK (quiet_hours_start IS NULL
                OR (quiet_hours_start BETWEEN 0 AND 23));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_quiet_hours_end_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_quiet_hours_end_chk
            CHECK (quiet_hours_end IS NULL
                OR (quiet_hours_end BETWEEN 0 AND 23));
    END IF;

    -- Both endpoints must be set together (or both NULL). A start-only
    -- or end-only row makes no sense — the policy resolver would have
    -- no window to apply.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_quiet_hours_pair_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_quiet_hours_pair_chk
            CHECK ((quiet_hours_start IS NULL AND quiet_hours_end IS NULL)
                OR (quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL));
    END IF;

    -- Pin the policy vocabulary to the three values the resolver
    -- understands; unknown values would silently fall through to
    -- legacy behaviour and the operator would have no way to tell.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_send_settings_quiet_hours_policy_chk'
    ) THEN
        ALTER TABLE tenant_send_settings
            ADD CONSTRAINT tenant_send_settings_quiet_hours_policy_chk
            CHECK (quiet_hours_policy IN ('snap', 'defer_to_end', 'skip'));
    END IF;
END$$;

COMMIT;
