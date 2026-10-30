-- 0159_campaigns_is_sandbox.sql
--
-- Forward-fix for D6 (PRODUCTION_READINESS.md): the sandbox flag
-- was only inspected at the HTTP-request boundary (via
-- sandbox.IsSandboxRequest reading the X-Postwave-Sandbox header
-- and api-key context). The Scheduler and the approved-hook queue
-- both run from background goroutines with NO request — so a
-- sandbox API key that scheduled or approval-queued a campaign
-- had its sandbox flag lost; the scheduler dispatched as a REAL
-- send.
--
-- Fix: persist the sandbox decision on the campaigns row at
-- create-time. Background dispatch paths read this column instead
-- of trying to derive sandbox-ness from a now-stale request
-- context.
--
-- Defaults to FALSE (non-sandbox), matching the historical
-- behavior for every existing row.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS is_sandbox boolean NOT NULL DEFAULT FALSE;

COMMIT;
