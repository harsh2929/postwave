-- 1926_bulk_recovery_add_to_list.sql
--
-- Bulk-adding people to a list was the one bulk verb with no undo.
--
-- Five bulk operations exist. tag and untag replay. delete and unsubscribe
-- deliberately do NOT — erasure and consent withdrawal must never be silently
-- resurrected, and the schema says so rather than trusting the handlers to
-- remember. `POST /api/v1/subscribers/bulk/list` was simply unbuilt, and it is
-- the easiest of the five to trigger by accident: one wrong segment in the
-- picker and the next campaign goes to an audience nobody chose.
--
-- WHAT THE EXISTING CHECK ENCODES, because it is easy to misread as a plain
-- enum and widen wrongly:
--
--   (operation IN ('tag','untag'))
--   OR ((operation IN ('delete','unsubscribe'))
--       AND subscriber_snapshot = '{}'
--       AND redeemed_at IS NOT NULL
--       AND recovery_until <= redeemed_at)
--
-- The second branch is not a list of allowed values, it is a shape: those two
-- operations may only exist as receipts that are ALREADY consumed, carry no
-- snapshot, and are already expired. That is how "this cannot be replayed" is
-- made structural instead of conventional — a handler that tried to mint a
-- live, snapshot-bearing delete receipt would be rejected by the database.
--
-- So `add_to_list` joins the FIRST branch and nothing else moves. The second
-- branch is re-stated verbatim. Widening the second branch, or collapsing the
-- two into one enum, would quietly make erasure look reversible again.
--
-- WHY ADDING TO A LIST IS SAFELY REVERSIBLE, where those two are not. It grants
-- no permission and destroys nothing: the undo removes memberships that this
-- operation itself created, within ten minutes, matched on the exact `added_at`
-- it wrote. A person who left and rejoined in that window has a different
-- timestamp and is skipped, so the undo cannot revoke a membership somebody
-- asked for after the mistake. Nothing about consent or erasure is touched.

-- rollback-strategy: no-op
--
-- LOCK DISCIPLINE, copied from 1768 — the migration this one supersedes, on this
-- same table — because dropping it here was an oversight rather than a decision.
--
-- Every bulk verb INSERTs into this table (tag, untag, add_to_list, delete,
-- unsubscribe), so the ACCESS EXCLUSIVE lock an ALTER takes blocks the entire
-- bulk surface for as long as it is held. Without `lock_timeout` the ALTER can
-- queue behind one long-running reader and take all five verbs down with it,
-- and the failure would arrive as "bulk operations are hanging" rather than as
-- a migration problem. `NOT VALID` splits the constraint's creation from its
-- scan, so the definition lands immediately instead of behind a full pass over
-- a table that has no retention sweep and therefore no bound on its size.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.subscriber_bulk_recovery
    DROP CONSTRAINT IF EXISTS subscriber_bulk_recovery_operation_check;

ALTER TABLE public.subscriber_bulk_recovery
    ADD CONSTRAINT subscriber_bulk_recovery_operation_check CHECK (
        (operation = ANY (ARRAY['tag'::text, 'untag'::text, 'add_to_list'::text]))
        OR (
            (operation = ANY (ARRAY['delete'::text, 'unsubscribe'::text]))
            AND subscriber_snapshot = '{}'::jsonb
            AND redeemed_at IS NOT NULL
            AND recovery_until <= redeemed_at
        )
    ) NOT VALID;

ALTER TABLE public.subscriber_bulk_recovery
    VALIDATE CONSTRAINT subscriber_bulk_recovery_operation_check;

COMMENT ON CONSTRAINT subscriber_bulk_recovery_operation_check
    ON public.subscriber_bulk_recovery IS
    'Two branches, and the second is a SHAPE rather than a list. Replayable '
    'operations (tag, untag, add_to_list) may hold a snapshot and sit '
    'unredeemed. delete and unsubscribe may exist only as already-consumed, '
    'snapshot-free, already-expired receipts — which is what makes "erasure and '
    'consent withdrawal are irreversible" a property of the database instead of '
    'a promise in the handlers. Widening the second branch would undo that.';

COMMIT;
