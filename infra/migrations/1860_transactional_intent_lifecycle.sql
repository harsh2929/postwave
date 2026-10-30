-- 1860_transactional_intent_lifecycle.sql
--
-- Intent identity and attempt state for the transactional send ledger.
--
-- THE DEFECT THIS CLOSES IS LIVE. Unlike most containment work in this repo,
-- `POST /api/v1/emails` and its scheduled worker are mounted, reachable, and
-- send real mail. Two things combine into a real duplicate send:
--
--   1. apps/api/internal/transactional/send.go dispatches to the provider and
--      THEN inserts the ledger row ("dispatch first, then record the outcome").
--      An insert failure leaves mail delivered with no record at all.
--   2. apps/api/internal/transactional/repo.go ClaimDue re-claims any row stuck
--      in `status='sending'` for more than ten minutes and re-dispatches it.
--      Its own comment concedes the point: "Re-dispatch is at-least-once; the
--      10-min guard makes a genuine double-send unlikely."
--
-- So a worker that stops after SES accepted a message but before the status
-- write leaves a `sending` row that is re-sent ten minutes later. "Unlikely" is
-- not a property; it is the absence of one. Blueprint metric M-03 asks for
-- ZERO confirmed duplicate irreversible provider effects per unique intent, and
-- today that is not measurable here, let alone zero.
--
-- The fix is to separate WHAT WAS ASKED FOR from WHAT THE PROVIDER DID:
--
--   intent_key      identifies the attempted invocation. Supplied by the
--                   caller's Idempotency-Key, or derived from the canonical
--                   request when absent, so every send has one. Unique per
--                   tenant, which is what makes a retry return the original id
--                   instead of sending twice.
--   request_hash    detects a reused key carrying different content — that is a
--                   caller bug, and answering it with the first message's id
--                   would silently drop the second.
--   attempt_state   prepared -> submitted | rejected | unknown. Only `prepared`
--                   is re-claimable, because only `prepared` proves the
--                   provider was never called. `unknown` is the honest state
--                   for a timeout: the provider may have accepted it, and no
--                   receipt exists to say. It is surfaced, never re-sent.
--   external_effect what we believe reached the outside world. Kept separate
--                   from attempt_state because "we failed to record it" and
--                   "it did not happen" are different facts, and conflating
--                   them is how the current code re-sends.
--
-- `status` is deliberately untouched: it is in the OpenAPI contract and six
-- SDKs, and the duplicate is fixed by the claim predicate, not by renaming what
-- callers already read.

BEGIN;

ALTER TABLE transactional_emails
    ADD COLUMN IF NOT EXISTS intent_key text,
    ADD COLUMN IF NOT EXISTS request_hash text,
    ADD COLUMN IF NOT EXISTS attempt_state text NOT NULL DEFAULT 'prepared',
    ADD COLUMN IF NOT EXISTS external_effect text NOT NULL DEFAULT 'none';

-- NOT VALID, then validated separately: a validated CHECK takes ACCESS
-- EXCLUSIVE and full-scans, which on a live send ledger is a write outage.
ALTER TABLE transactional_emails
    DROP CONSTRAINT IF EXISTS transactional_emails_attempt_state_check;
ALTER TABLE transactional_emails
    ADD CONSTRAINT transactional_emails_attempt_state_check
    CHECK (attempt_state IN ('prepared', 'submitted', 'acknowledged', 'rejected', 'unknown'))
    NOT VALID;

ALTER TABLE transactional_emails
    DROP CONSTRAINT IF EXISTS transactional_emails_external_effect_check;
ALTER TABLE transactional_emails
    ADD CONSTRAINT transactional_emails_external_effect_check
    CHECK (external_effect IN ('none', 'partial', 'full', 'unknown'))
    NOT VALID;

COMMIT;

ALTER TABLE transactional_emails
    VALIDATE CONSTRAINT transactional_emails_attempt_state_check;
ALTER TABLE transactional_emails
    VALIDATE CONSTRAINT transactional_emails_external_effect_check;

-- Existing rows predate intent identity and must not collide with each other:
-- the index is partial so they simply do not participate. A backfill would have
-- to invent an intent for a send whose request nobody recorded.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS transactional_emails_intent_key_idx
    ON transactional_emails (tenant_id, intent_key)
    WHERE intent_key IS NOT NULL;

-- The claim predicate scans by (attempt_state, status, scheduled_at).
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_emails_claimable_idx
    ON transactional_emails (scheduled_at)
    WHERE attempt_state = 'prepared';
