-- 1910_web_vitals_events_retention_delete.sql
--
-- The GLOBAL retention sweep never ran — neither of its two statements.
--
-- `retention.Sweeper.sweepGlobal` prunes two non-tenant tables:
--
--     DELETE FROM web_vitals_events        WHERE at < now() - N days
--     DELETE FROM stripe_webhook_attempts  WHERE ... AND updated_at < now() - N days
--
-- It runs on the application pool as `postwave_app`, which holds INSERT and
-- SELECT on `web_vitals_events` and no DELETE. That first statement raised
-- `permission denied for table web_vitals_events` — and because sweepGlobal
-- returns on the first error, the SECOND statement never ran either. So
-- stripe_webhook_attempts was never pruned despite having its grant: one
-- missing privilege disabled the whole function.
--
-- NO CAPABILITY GATE HERE, and that is deliberate rather than an omission.
-- The audit-log (1902), tenant-exports (1908) and webhook-deliveries (1909)
-- fixes each paired their grant with a RESTRICTIVE policy, because those tables
-- carry FORCE ROW LEVEL SECURITY and a permissive tenant policy that a bare
-- grant would have widened into "any tenant may delete its own history".
-- `web_vitals_events` has no RLS at all and no tenant scope — it is global
-- telemetry swept globally — so there is no permissive policy to widen and
-- nothing for a capability to distinguish. Enabling RLS on it to hang a gate
-- from would be a larger change than the bug warrants, and would not make the
-- data safer.
--
-- The sibling statement's table, `stripe_webhook_attempts`, already holds a
-- plain DELETE grant with no gate. This makes the two consistent.

BEGIN;

GRANT DELETE ON web_vitals_events TO postwave_app;

COMMIT;
