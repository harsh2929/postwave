-- 2050_form_submission_response_and_confirmation_email.sql
--
-- migration-execution: phased
-- rollback-strategy: expand-contract - the previous release never writes the
-- new status or columns; it reads status as free text, so a 'received' row
-- shows there as an unrecognised status and nothing fails.
-- rollback-details: leave this migration applied during a rollback.
--
-- Two facts about a public form submission that the table could not record.
--
-- 1. status 'received'. A form with a consent checkbox the visitor left
--    unticked records the response and subscribes nobody. It used to be
--    stored as 'confirmed', so the Submissions page, its Confirmed filter,
--    the form.confirmed report metric and the form.submitted webhook all
--    counted it as a confirmed signup. 'received' is a response that did not
--    ask to subscribe: nothing to confirm, nothing joined. Rows written before
--    this migration keep the status they have: nothing on them says whether
--    the visitor ticked a box.
--
-- 2. confirmation_email_state / confirmation_email_at. A double opt-in email
--    used to be sent once, synchronously, with a failure only logged, so the
--    Submissions page could not tell "the email never left" from "the visitor
--    has not clicked yet". The email is now sent by a durable outbox event;
--    these columns hold the last outcome the operator acts on:
--      queued                the send is waiting in the outbox
--      sent                  the mailer accepted it
--      send_failed           the mailer refused it; the outbox retries
--      no_sender             no sender may send it for this workspace
--      quota_exceeded        the workspace hit the hourly limit of the
--                            standard sender; the outbox retries
--      recipient_suppressed  the address bounced, complained, or was erased
--    NULL for submissions with no confirmation email. The partial index
--    serves the per-workspace hourly count of sent confirmations.
--
-- LOCKING. ADD COLUMN without a default and the NOT VALID constraints are
-- catalogue changes, so the DDL transaction holds ACCESS EXCLUSIVE only
-- briefly. The status constraint is swapped inside that transaction, so no
-- row is ever unchecked. Validation and the index build run afterwards, one
-- statement each, under SHARE UPDATE EXCLUSIVE, which lets the public submit
-- and confirm endpoints keep writing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE form_submissions
    ADD COLUMN IF NOT EXISTS confirmation_email_state text,
    ADD COLUMN IF NOT EXISTS confirmation_email_at timestamptz;

ALTER TABLE form_submissions DROP CONSTRAINT IF EXISTS form_submissions_status_check;
ALTER TABLE form_submissions
    ADD CONSTRAINT form_submissions_status_check
    CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'received')) NOT VALID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.form_submissions'::regclass
           AND conname = 'form_submissions_confirmation_email_state_chk'
    ) THEN
        ALTER TABLE form_submissions
            ADD CONSTRAINT form_submissions_confirmation_email_state_chk
            CHECK (confirmation_email_state IS NULL OR confirmation_email_state IN (
                'queued', 'sent', 'send_failed', 'no_sender', 'quota_exceeded', 'recipient_suppressed'
            )) NOT VALID;
    END IF;
END $$;

COMMENT ON COLUMN form_submissions.status IS
    'pending: awaiting the double opt-in click. confirmed: subscribed (single '
    'opt-in, or the link was clicked). unsubscribed: opted out through the '
    'submission. received: a response that did not ask to subscribe.';
COMMENT ON COLUMN form_submissions.confirmation_email_state IS
    'Last outcome of the double opt-in email: queued, sent, send_failed, '
    'no_sender, quota_exceeded or recipient_suppressed. NULL when the '
    'submission has no confirmation email.';
COMMENT ON COLUMN form_submissions.confirmation_email_at IS
    'When confirmation_email_state last changed.';

COMMIT;

ALTER TABLE form_submissions VALIDATE CONSTRAINT form_submissions_status_check;
ALTER TABLE form_submissions VALIDATE CONSTRAINT form_submissions_confirmation_email_state_chk;

CREATE INDEX CONCURRENTLY IF NOT EXISTS form_submissions_confirmation_sent_idx
    ON form_submissions (tenant_id, confirmation_email_at)
    WHERE confirmation_email_state = 'sent';
