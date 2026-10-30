-- 1895_action_tickets_worker_sweep.sql
--
-- Let the sweep see the tickets it is meant to delete.
--
-- FOURTH time this exact shape has appeared in one session, which is now the
-- most useful thing about it. A cross-tenant maintenance job runs under
-- `app.outbox_worker` with no tenant GUC; a RESTRICTIVE policy that does not
-- name that capability evaluates `tenant_id = NULL` and the job sees nothing.
-- The DELETE affects zero rows, reports success, and looks exactly like a
-- healthy sweep with nothing to do.
--
--   1887  web_push_deliveries
--   1888  web_push_subscriptions
--   1890  notification_preferences
--   1895  action_tickets            (this one)
--
-- Each was caught only by a test asserting the WORK happened — a re-delivery
-- landing, a row disappearing — never by one asserting the call returned no
-- error. 1893's policy admitted the tenant scope and the auth resolver, because
-- those are the two paths that MINT and REDEEM; the sweep was written
-- afterwards and nothing connected the two.
--
-- Deliberately not a blanket bypass: a transaction with none of the three
-- capabilities still sees nothing.

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON action_tickets;
CREATE POLICY tenant_isolation ON action_tickets
    AS RESTRICTIVE
    USING (
        -- Mint: a normal tenant-scoped request.
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        -- Redeem: pre-tenant, because the bearer has no session by design.
        OR current_setting('app.auth_resolver', true) = 'true'
        -- Sweep: cross-tenant maintenance, which is what this migration adds.
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.auth_resolver', true) = 'true'
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
