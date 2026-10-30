-- Subscriber merges and email-address rotations re-point the historical event
-- stream from the previous subscriber_email to the surviving address.  The
-- application role can already SELECT and INSERT these tenant-scoped rows, but
-- lacked the column-level UPDATE privilege required by that production path.
-- Keep the grant deliberately narrow: event payloads, types, timestamps, and
-- tenant ownership remain immutable to the application role.

BEGIN;

GRANT UPDATE (subscriber_email) ON subscriber_events TO postwave_app;

COMMIT;
