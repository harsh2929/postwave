-- 2049_form_submission_signup_record.sql
--
-- migration-execution: phased
-- rollback-strategy: expand-contract - the previous release neither reads nor
-- writes these columns, so it keeps working with them present.
-- rollback-details: leave this migration applied during a rollback.
--
-- Make a public form submission carry everything needed to put the visitor in
-- the workspace's audience.
--
-- A hosted form submission used to write Listmonk and form_submissions and
-- nothing else. The canonical subscribers row, the list membership campaigns
-- send from, and the subscriber's consent were never written, so a signup
-- showed up on the Lists card (counted in Listmonk) but not in Subscribers,
-- not in the list's Members, and never in a campaign audience. The durable
-- outbox handler that now writes that audience state reloads the submission by
-- id rather than trusting a payload, so the row itself has to hold what the
-- visitor gave and what the form resolved:
--
--   name             the name the visitor typed. It went only to Listmonk,
--                    so Postwave never knew it. Subject-provided personal data:
--                    the SAR export discloses the column, and form_submissions
--                    is declared as holding subject data. The Art. 17 erasure
--                    worker does not erase form_submissions rows yet (the table
--                    is not in its covered tables), so this column shares the
--                    gap its email, custom_fields and ip columns already have;
--                    the retention sweep is what removes them today.
--   target_list_ids  the workspace lists (Postwave list UUIDs) this submission
--                    joins, resolved through list_id_map under the form's
--                    tenant at submit time. Stored, not re-read from the form
--                    at confirmation time: a double opt-in confirmed a week
--                    later joins the list the visitor signed up to, not
--                    whatever the form targets by then.
--   signup_source    where the form was submitted: the hosted page (including
--                    a script or iframe embed of it) or an HTML form the
--                    workspace embedded on its own site. The vocabulary is the
--                    two form values of subscribers.signup_source (0303).
--                    NULL for submissions recorded before this migration.
--
-- LOCKING. ADD COLUMN with a constant default is a catalogue change in
-- PostgreSQL 11+, so the DDL transaction holds ACCESS EXCLUSIVE only briefly.
-- The CHECK constraints are added NOT VALID there (they bind every new row at
-- once) and validated in a second phase, whose SHARE UPDATE EXCLUSIVE lock
-- lets the public submit and confirm endpoints keep writing during the scan.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE form_submissions
    ADD COLUMN IF NOT EXISTS name text,
    ADD COLUMN IF NOT EXISTS target_list_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN IF NOT EXISTS signup_source text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.form_submissions'::regclass
           AND conname = 'form_submissions_name_length_chk'
    ) THEN
        ALTER TABLE form_submissions
            ADD CONSTRAINT form_submissions_name_length_chk
            CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.form_submissions'::regclass
           AND conname = 'form_submissions_signup_source_chk'
    ) THEN
        ALTER TABLE form_submissions
            ADD CONSTRAINT form_submissions_signup_source_chk
            CHECK (signup_source IS NULL OR signup_source IN ('hosted_page', 'embedded_form')) NOT VALID;
    END IF;
END $$;

COMMENT ON COLUMN form_submissions.name IS
    'Name the visitor typed into the form. NULL when the form collected none. '
    'Subject-provided personal data: disclosed by the SAR export; not yet '
    'erased by the Art. 17 worker, like the row''s email, custom_fields and ip.';
COMMENT ON COLUMN form_submissions.target_list_ids IS
    'Postwave list UUIDs this submission joins, resolved through list_id_map '
    'under the form''s tenant when it was submitted. Empty when the form targets '
    'no list.';
COMMENT ON COLUMN form_submissions.signup_source IS
    'hosted_page or embedded_form (the form values of subscribers.signup_source). '
    'NULL for submissions recorded before migration 2049.';

COMMIT;

ALTER TABLE form_submissions VALIDATE CONSTRAINT form_submissions_name_length_chk;
ALTER TABLE form_submissions VALIDATE CONSTRAINT form_submissions_signup_source_chk;
