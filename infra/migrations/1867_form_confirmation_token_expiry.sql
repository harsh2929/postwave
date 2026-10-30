-- 1867_form_confirmation_token_expiry.sql
--
-- migration-execution: phased
--
-- Give double-opt-in confirmation tokens an expiry.
--
-- `form_submissions.confirmation_token` had none. The confirm path was
-- `WHERE confirmation_token = $1 AND status = 'pending'` with no time
-- predicate, so a confirmation link worked forever: a DOI email forwarded,
-- archived, or recovered from a breach years later still granted marketing
-- consent, and the consent record would be dated to the click rather than to
-- anything the subscriber did recently.
--
-- The divergence is inside one product. `preference_tokens` (the preference
-- centre) has an `expires_at` column, a dedicated `ErrTokenExpired`, and even a
-- rendered expired page — so this codebase already decided that a
-- consent-bearing link must age out, and applied that decision to one of its two
-- consent-bearing links.
--
-- WINDOW. 30 days. Long enough that an ordinary "confirm later" still works
-- across a holiday; short enough that a forwarded link is not a standing
-- consent grant. Stored per row rather than as a global constant so a tenant
-- with a different regulatory posture can be given a different window without a
-- migration.
--
-- EXISTING ROWS. Backfilled to `submitted_at + 30 days`, which means historic
-- pending confirmations older than that become expired immediately. That is the
-- point: an unconfirmed submission from last year is not a pending consent, and
-- treating it as one is the behaviour being removed. A recipient who still wants
-- to subscribe can submit the form again, which is the same number of clicks.

-- I1: the ADD COLUMN and the backfill are SEPARATE phases.
--
-- `ALTER TABLE ... ADD COLUMN` takes ACCESS EXCLUSIVE and Postgres holds it to
-- COMMIT, so an unbounded UPDATE inside the same transaction blocks every read
-- and write to form_submissions for its whole duration — public submits,
-- confirms and admin lists alike. `infra/migrations/README.md` defines the
-- `phased` directive as exactly this split: brief lock-taking DDL in a
-- transaction, long statements after it commits. Migration 1860 reasons about
-- the same hazard on the send ledger and splits accordingly; the first version
-- of this file declared `phased` and then did the opposite.

BEGIN;

ALTER TABLE form_submissions
    ADD COLUMN IF NOT EXISTS confirmation_expires_at timestamptz;

COMMENT ON COLUMN form_submissions.confirmation_expires_at IS
    'When the double-opt-in confirmation link stops granting consent. NULL only '
    'for rows that never had a token. Mirrors preference_tokens.expires_at — a '
    'consent-bearing link must age out, and this table was the one that did not. '
    'The 30-day window matches preferences.DefaultTokenTTL and the '
    'List-Unsubscribe fallback.';

COMMIT;

-- Batched, outside the DDL transaction, so no single statement holds a long
-- lock on a table the public form endpoints write to.
DO $$
DECLARE
    v_rows integer;
BEGIN
    LOOP
        UPDATE form_submissions
           SET confirmation_expires_at = submitted_at + interval '30 days'
         WHERE id IN (
             SELECT id FROM form_submissions
              WHERE confirmation_token IS NOT NULL
                AND confirmation_expires_at IS NULL
              LIMIT 5000);
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        EXIT WHEN v_rows = 0;
        COMMIT;
    END LOOP;
END $$;

-- I2: NO new index. `form_submissions_token_idx` has existed since migration
-- 0007 — UNIQUE btree (confirmation_token) WHERE confirmation_token IS NOT NULL
-- — with an identical predicate and key. A second, non-unique copy would be
-- pure write amplification on the table's hottest write path. The confirm
-- lookup was already indexed; adding the expiry to the WHERE does not change
-- which index serves it.
