-- 1887_web_push_deliveries_worker_scope.sql
--
-- Let the retry worker see the rows it exists to retry.
--
-- Migration 1883 gave `web_push_deliveries` a RESTRICTIVE tenant_isolation
-- policy — the house idiom, and the right default: without a tenant scope you
-- see nothing. The retry worker is cross-tenant by nature (it sweeps every
-- tenant's due deliveries in one pass) and runs under `app.outbox_worker`, with
-- no tenant GUC. Under a RESTRICTIVE policy that evaluates to `tenant_id =
-- NULL`, so the worker saw zero rows and silently retried nothing.
--
-- It was silent in the worst way: the sweep succeeded, reported zero retries,
-- and looked exactly like "nothing was due". The retry test caught it only
-- because it asserted a notification was actually re-sent rather than that the
-- sweep returned no error.
--
-- `mobile_push_deliveries` reached the same place by a different route: its
-- policies are PERMISSIVE, so a separate worker policy ORs with tenant
-- isolation. This table keeps the stricter RESTRICTIVE base and admits the
-- worker inside it, which means the default is still deny and the exception is
-- named in one place instead of two.

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON web_push_deliveries;
CREATE POLICY tenant_isolation ON web_push_deliveries
    AS RESTRICTIVE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        -- The declared worker scope, the same GUC db.WithWorkerScope binds.
        -- Deliberately NOT a blanket bypass: a transaction that has neither a
        -- tenant nor this capability still sees nothing.
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
