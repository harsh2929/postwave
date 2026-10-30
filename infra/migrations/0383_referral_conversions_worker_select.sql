-- 0383_referral_conversions_worker_select.sql
--
-- Desktop audit 2026-06-10 (referrals/congrats_sender.go): the congrats
-- worker's dueConversions scan is cross-tenant — it lists conversions
-- for EVERY tenant and only then re-enters tenant scope per row. The
-- query historically ran as a bare Pool.Query with no GUC bound, and
-- referral_conversions is FORCE-RLS with a tenant-gated policy, so the
-- scan silently returned zero rows forever: no congrats emails, no
-- payout rows from the event-driven producer.
--
-- Fix has two halves:
--   1. Go side: dueConversions now runs under db.WithWorkerScope
--      (binds app.outbox_worker = 'true' transaction-locally).
--   2. This migration: open a read-only worker gate on
--      referral_conversions, mirroring audience_syncs_worker_select
--      (0376) / tenant_worker_select (1708).
--
-- referral_conversions has BOTH policy kinds:
--   * tenant_isolation (RESTRICTIVE, 0072) — ANDed on top of everything,
--     so a new permissive policy alone changes nothing (the 0325
--     external_warehouse_triggers lesson). We re-create it with the
--     worker GUC ORed into USING.
--   * tenant_visible (PERMISSIVE, 0079) — stays as-is for request paths.
--
-- Write surface is intentionally NOT widened: the new permissive policy
-- is FOR SELECT only, and the restrictive policy's WITH CHECK stays
-- tenant-only, so worker scope without a bound tenant can read but never
-- insert/update conversion rows. All worker writes (markSent,
-- EnsurePendingPayout) go through db.WithTenant and are unaffected.
--
-- rollback-strategy: no-op - policy-only change; previous releases never
-- relied on the worker gate (the scan simply returned zero rows), so
-- leaving the policies in place during a rollback is safe.

BEGIN;

-- Defensive no-ops: 0072 already enabled + forced RLS.
ALTER TABLE referral_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_conversions FORCE  ROW LEVEL SECURITY;

-- Permissive worker read gate (mirrors audience_syncs_worker_select).
DROP POLICY IF EXISTS referral_conversions_worker_select ON referral_conversions;
CREATE POLICY referral_conversions_worker_select ON referral_conversions
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- Widen the RESTRICTIVE gate's read side so the permissive policy above
-- can actually fire under worker scope (restrictive policies AND).
-- WITH CHECK deliberately stays tenant-only — see header comment.
DROP POLICY IF EXISTS tenant_isolation ON referral_conversions;
CREATE POLICY tenant_isolation ON referral_conversions
    AS RESTRICTIVE FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
