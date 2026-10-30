-- 1768_subscriber_bulk_recovery_privacy_boundary.sql
--
-- Privacy erasure and consent withdrawal are irreversible. Migration 1300
-- previously allowed recovery rows for both operations, including complete
-- deleted-subscriber JSON snapshots. Even after current handlers stopped
-- minting those tokens, an unexpired historical token could retain or restore
-- erased PII. Irreversibly scrub that legacy recovery material while retaining
-- a non-PII operation/count tombstone for audit continuity. New reversible
-- receipts remain limited to tag and untag.
--
-- rollback-strategy: no-op
-- rollback-details: scrubbed privacy snapshots must never be reconstructed and
-- the terminal-tombstone constraint is intentionally retained. Older code that
-- attempts to mint a replayable delete/unsubscribe token fails closed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

UPDATE public.subscriber_bulk_recovery
   SET subscriber_snapshot = '{}'::jsonb,
       recovery_until = LEAST(recovery_until, statement_timestamp()),
       redeemed_at = GREATEST(
           COALESCE(redeemed_at, statement_timestamp()),
           statement_timestamp()
       )
 WHERE operation IN ('delete', 'unsubscribe')
   AND (
       subscriber_snapshot <> '{}'::jsonb OR
       redeemed_at IS NULL OR
       recovery_until > statement_timestamp()
   );

ALTER TABLE public.subscriber_bulk_recovery
    DROP CONSTRAINT IF EXISTS subscriber_bulk_recovery_operation_check;

ALTER TABLE public.subscriber_bulk_recovery
    ADD CONSTRAINT subscriber_bulk_recovery_operation_check
    CHECK (
        operation IN ('tag', 'untag') OR
        (
            operation IN ('delete', 'unsubscribe') AND
            subscriber_snapshot = '{}'::jsonb AND
            redeemed_at IS NOT NULL AND
            recovery_until <= redeemed_at
        )
    ) NOT VALID;

ALTER TABLE public.subscriber_bulk_recovery
    VALIDATE CONSTRAINT subscriber_bulk_recovery_operation_check;

COMMENT ON CONSTRAINT subscriber_bulk_recovery_operation_check
    ON public.subscriber_bulk_recovery IS
    'Only tag changes are replayable; historical deletion/withdrawal rows must be expired, redeemed, payload-free audit tombstones.';

COMMENT ON COLUMN public.subscriber_bulk_recovery.subscriber_snapshot IS
    'Reverse-operation payload for tag/untag only; privacy erasure and consent withdrawal tombstones must contain an empty object.';

COMMIT;
