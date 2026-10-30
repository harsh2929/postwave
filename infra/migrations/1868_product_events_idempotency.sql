-- 1868_product_events_idempotency.sql
--
-- migration-execution: phased
--
-- Give `POST /api/v1/track` an idempotency key.
--
-- The insert had no `ON CONFLICT` and the table had no unique key beyond its
-- surrogate id, so a retried request produced a second row. Client SDKs retry on
-- timeout by design, and a timeout is exactly the case where the write may
-- already have succeeded — so the events most likely to be duplicated are the
-- ones on a slow or flaky connection.
--
-- The consequence is not cosmetic. `product_events` drives flow triggers
-- (`fanoutEvent` fires per row), segment membership and the subscriber
-- timeline. A double-counted `purchase` can enrol someone in an abandoned-cart
-- flow twice, and a metric built on event counts is silently inflated for
-- precisely the users with the worst connectivity.
--
-- OPTIONAL, not mandatory. A caller that supplies `event_id` gets exactly-once;
-- one that does not keeps today's behaviour. Making it required would break
-- every existing integration, and a server-generated key would defeat the
-- purpose — the whole point is that the CLIENT can name the same event twice.
--
-- The index is partial so rows without a key do not contend on it, and unique
-- per (tenant, event_id) rather than including subscriber_id: a client's id
-- must mean one event, not one event per subscriber it happens to be attached
-- to, or a mis-attributed retry would still land twice.

BEGIN;

ALTER TABLE product_events
    ADD COLUMN IF NOT EXISTS event_id text;

COMMENT ON COLUMN product_events.event_id IS
    'Optional client-supplied idempotency key for POST /api/v1/track. When '
    'present, a retry of the same event is a no-op rather than a second row. '
    'Absent for callers that do not send one, which is why the unique index is '
    'partial. Deliberately not server-generated: the point is that the client '
    'can name the same event twice.';

COMMIT;

-- CONCURRENTLY: product_events is a high-volume append path and a plain unique
-- index build would take an ACCESS EXCLUSIVE lock across the whole table.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS product_events_tenant_event_id_idx
    ON product_events (tenant_id, event_id)
    WHERE event_id IS NOT NULL;
