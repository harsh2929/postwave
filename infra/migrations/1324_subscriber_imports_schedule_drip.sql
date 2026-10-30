-- 1324_subscriber_imports_schedule_drip.sql
--
-- SUB-104: scheduled / drip CSV import.
--
-- Today a Confirm flips subscriber_imports.status straight to 'queued'
-- and the background worker drains it immediately. Marketers running a
-- large refresh want two things parity tools (Klaviyo/Mailchimp) offer:
--
--   1. Run-at scheduling — "kick this off at 02:00 UTC", or a weekly
--      cadence — instead of the moment they click Confirm.
--   2. Drip pacing — spread an N-row file across M hours so the
--      downstream ESP / warming reputation isn't hammered by a single
--      burst.
--
-- This extends the existing subscriber_imports table (0134, 0282, 0363)
-- with the schedule + drip knobs the wizard's final step PATCHes onto
-- the preview row. The worker's claimNextJob gains a
-- `next_scheduled_at <= now()` gate so a scheduled row only becomes
-- claimable once it's due; the immediate-import path leaves
-- next_scheduled_at NULL and stays claimable the instant it's 'queued'.
--
-- Columns:
--   * schedule_type        — 'immediate' (default, unchanged behaviour),
--                            'scheduled' (one-shot run_at), or 'cron'
--                            (recurring; schedule_cron holds the expr).
--   * schedule_cron        — cron expression for recurring schedules
--                            (e.g. the wizard's "weekly 02:00 UTC").
--   * scheduled_at         — the operator-chosen one-shot run time (UTC).
--   * next_scheduled_at    — the computed instant the worker may claim
--                            the row. NULL = claimable now (immediate).
--   * drip_hours_interval  — hours between drip chunks (0 = no drip).
--   * drip_hours_total     — total hours to spread the file across
--                            (0 = ignore; informational + UI display).
--
-- No new tables, so the existing 0134 tenant_visible RLS policy
-- (NULLIF(current_setting('app.tenant_id', true), '')::uuid OR
-- app.outbox_worker) keeps covering the rows. The GUC idiom MUST use
-- NULLIF so an unset app.tenant_id doesn't crash the ::uuid cast.

BEGIN;

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS schedule_type       text NOT NULL DEFAULT 'immediate'
                                CHECK (schedule_type IN ('immediate','scheduled','cron')),
    ADD COLUMN IF NOT EXISTS schedule_cron       text,
    ADD COLUMN IF NOT EXISTS scheduled_at        timestamptz,
    ADD COLUMN IF NOT EXISTS next_scheduled_at   timestamptz,
    ADD COLUMN IF NOT EXISTS drip_hours_interval int  NOT NULL DEFAULT 0
                                CHECK (drip_hours_interval >= 0),
    ADD COLUMN IF NOT EXISTS drip_hours_total    int  NOT NULL DEFAULT 0
                                CHECK (drip_hours_total >= 0),
    -- last_drip_at lets the worker pace drip chunks: it claims a due row,
    -- applies one chunk, then re-arms next_scheduled_at = now() +
    -- drip_hours_interval so the next chunk waits out the interval.
    ADD COLUMN IF NOT EXISTS last_drip_at        timestamptz;

-- The worker's claim query adds a `next_scheduled_at IS NULL OR
-- next_scheduled_at <= now()` gate on top of the existing
-- status IN ('queued','running') filter. subscriber_imports is a
-- low-volume operational table (import jobs, not subscribers), so the
-- existing partial index idx_subscriber_imports_queued (status, created_at)
-- already narrows the scan to the handful of in-flight rows; the
-- next_scheduled_at predicate is evaluated cheaply over that tiny set. We
-- deliberately do NOT rebuild the index here — a non-CONCURRENT rebuild
-- would take an ACCESS EXCLUSIVE lock for no measurable benefit on a table
-- this small.

COMMIT;
