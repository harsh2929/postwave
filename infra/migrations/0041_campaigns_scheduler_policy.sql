-- 0041_campaigns_scheduler_policy.sql
--
-- Adds a permissive RLS policy on `campaigns` so the cross-tenant
-- send-scheduler can read rows without binding app.tenant_id per
-- tenant. Mirrors the pattern used by outbox_events in 0035 and
-- tenant_webhooks in 0017.
--
-- The scheduler sets app.outbox_worker='true' before its SELECT, then
-- binds app.tenant_id to the matched row's tenant before any UPDATE.
-- Tenant isolation is preserved end-to-end: only the platform-wide
-- discovery query benefits from the bypass.

BEGIN;

CREATE POLICY campaigns_scheduler_select ON campaigns
    AS PERMISSIVE
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;
