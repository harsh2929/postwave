-- 1998_sms_inbox_lifecycle_cas.sql
--
-- A read receipt and an operator lifecycle decision share
-- sms_conversation_state, but they are different concurrency domains. The
-- existing updated_at value is created even for a read-only marker, so it
-- cannot safely be used as the optimistic-lock token for archive, snooze,
-- assignment, or notes mutations.
--
-- rollback-strategy: no-op
-- rollback-details: Keep the additive nullable token when rolling the application back. Legacy readers ignore it, and removing it would discard the only safe CAS baseline for already-versioned lifecycle rows.

BEGIN;

ALTER TABLE sms_conversation_state
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at timestamptz NULL;

ALTER TABLE sms_conversation_state
  ADD CONSTRAINT sms_conversation_state_lifecycle_timestamp_check CHECK (
    (lifecycle_updated_at IS NULL OR
      public.sms_timestamp_valid(lifecycle_updated_at)) AND
    (lifecycle_updated_at IS NOT NULL OR (
      snooze_until IS NULL AND
      archived_at IS NULL AND
      assignee_user_id IS NULL AND
      notes = ''
    ))
  ) NOT VALID;

-- Preserve an authoritative initial version for rows that already contain an
-- operator-managed value. Read-marker-only rows deliberately remain NULL; a
-- client that observed no lifecycle state can therefore still perform the
-- first lifecycle mutation after opening (and marking read) a thread.
UPDATE sms_conversation_state
   SET lifecycle_updated_at = updated_at
 WHERE lifecycle_updated_at IS NULL
   AND (
     snooze_until IS NOT NULL OR
     archived_at IS NOT NULL OR
     assignee_user_id IS NOT NULL OR
     notes <> ''
   );

ALTER TABLE sms_conversation_state
  VALIDATE CONSTRAINT sms_conversation_state_lifecycle_timestamp_check;

COMMIT;
