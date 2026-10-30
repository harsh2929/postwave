-- 1888_web_push_subscriptions_worker_read.sql
--
-- The retry worker needs the endpoint it is retrying to.
--
-- Migration 1887 let the worker see `web_push_deliveries`, and the sweep still
-- returned nothing: the claim JOINs `web_push_subscriptions` for the endpoint
-- and encryption keys, and that table is tenant-scoped with no worker policy.
-- An inner join against zero visible rows produces zero rows, silently — the
-- sweep succeeded, reported no retries, and looked exactly like "nothing due".
--
-- `mobile_push_devices` carries a `worker_claim` policy for precisely this
-- reason; its delivery claim joins the device table the same way. This is the
-- same grant, deliberately narrower.
--
-- SELECT ONLY. The worker reads an endpoint to send to it and never needs to
-- write: pruning a dead subscription on 410 already runs tenant-scoped through
-- the normal path. A push endpoint URL is effectively a send credential for
-- that browser, so the worker gets the minimum that lets it do its job and no
-- ability to create, alter or delete one.

BEGIN;

DROP POLICY IF EXISTS worker_read ON web_push_subscriptions;
CREATE POLICY worker_read ON web_push_subscriptions
    FOR SELECT
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMENT ON POLICY worker_read ON web_push_subscriptions IS
    'Read-only, worker-scoped access for the web push retry sweep, which is '
    'cross-tenant and joins this table for the endpoint and keys. Writes stay '
    'tenant-scoped.';

COMMIT;
