-- 1901_inbound_events_lockable_not_writable.sql
--
-- Every DUPLICATE inbound webhook delivery failed with a permission error.
--
-- `RecordEventWithActions` dedupes by inserting and, on conflict, reading the
-- row that already exists:
--
--     INSERT INTO inbound_events ... ON CONFLICT (endpoint_id, source_event_id)
--         WHERE source_event_id IS NOT NULL DO NOTHING RETURNING id
--     -- no row returned => already received; read it back:
--     SELECT id, body_bytes, authenticated_raw_body_sha256
--       FROM inbound_events WHERE endpoint_id = $1 AND source_event_id = $2
--      ORDER BY id DESC LIMIT 1 FOR SHARE
--
-- `postwave_app` holds SELECT, INSERT and DELETE on this table — deliberately
-- not UPDATE, because it is an append-only event log. But PostgreSQL requires
-- UPDATE privilege for a row-locking clause: FOR SHARE needs it "for at least
-- one column of each table so selected". So the read back raised
--
--     ERROR: permission denied for table inbound_events
--
-- while the plain SELECT on the same rows succeeded.
--
-- THAT PATH IS THE COMMON CASE. Webhook providers deliver at least once and
-- retry aggressively; a redelivery of an event already recorded is normal
-- traffic, not an edge. So the second delivery of any event with a
-- source_event_id errored rather than being recognised as a duplicate.
--
-- The lock is load-bearing and must stay. It holds the existing row against a
-- concurrent retention DELETE for the rest of the transaction, which then plans
-- actions referencing that event id — without it the FK could fail underneath a
-- delivery that had already been accepted.
--
-- So: make the table LOCKABLE without making it WRITABLE. The UPDATE grant is
-- what PostgreSQL checks for the lock; a RESTRICTIVE policy with
-- `WITH CHECK (false)` is what makes an actual UPDATE impossible. Only USING is
-- evaluated when a row is locked rather than modified, so the lock proceeds and
-- any real write is rejected — the append-only guarantee is preserved by the
-- policy instead of by the absent grant.
--
-- Same shape as 1900 on pii_scan_runtime_contract, and the same root cause: a
-- row-locking clause needs more than read access, and the failure is a
-- permission error at runtime on a path nobody exercised.

BEGIN;

GRANT UPDATE ON inbound_events TO postwave_app;

DROP POLICY IF EXISTS inbound_events_append_only ON inbound_events;
CREATE POLICY inbound_events_append_only ON inbound_events
    AS RESTRICTIVE
    FOR UPDATE
    USING (true)
    WITH CHECK (false);

COMMENT ON POLICY inbound_events_append_only ON inbound_events IS
    'The UPDATE grant exists only so SELECT ... FOR SHARE can take a row lock '
    'during duplicate detection; PostgreSQL requires UPDATE privilege for a '
    'locking clause. WITH CHECK (false) makes an actual UPDATE impossible, so '
    'the log stays append-only. Without the grant every redelivered webhook '
    'raised "permission denied for table inbound_events".';

COMMIT;
