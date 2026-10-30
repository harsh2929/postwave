-- 1832_campaign_template_design_retry_receipts.sql
--
-- Record the draft attempt count observed when a retry idempotency key wins
-- the failed-to-queued transition. The application inserts this receipt in
-- the same transaction as queueing, so a non-NULL value proves that this exact
-- key queued work. Competing keys cannot register against that queued work.
--
-- A retry may be claimed and fail again before the client replays an
-- ambiguous response. Mutable status alone cannot identify the winning key;
-- this immutable transaction-bound receipt can.
--
-- Existing mutation rows remain NULL and therefore fail closed when replay
-- cannot be proven. Non-retry operations never populate this receipt.
--
-- rollback-strategy: no-op
-- rollback-details: retain the receipt and database guard. Older binaries do
-- not implement the atomic protocol and their retry writes intentionally fail
-- closed; drain them before enabling retry traffic or rolling the app back.

BEGIN;

ALTER TABLE campaign_template_design_mutations
    ADD COLUMN registered_attempt_count integer
        CHECK (
            registered_attempt_count IS NULL
            OR (
                operation = 'retry'
                AND registered_attempt_count >= 0
            )
        );

COMMENT ON COLUMN
    campaign_template_design_mutations.registered_attempt_count IS
    'Draft attempt_count atomically recorded with a retry failed-to-queued transition; NULL for non-retry and pre-1832 identities.';

-- Enforce transaction authorization for the atomic protocol in the database.
-- During a rolling deployment an older binary may still try the former
-- register-then-queue sequence. It does not set the transaction-local receipt
-- identity, so the transition fails closed instead of duplicating a retry
-- accepted by a newer binary.
CREATE OR REPLACE FUNCTION enforce_campaign_template_design_retry_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    receipt_key_hex text;
BEGIN
    IF OLD.status = 'failed' AND NEW.status = 'queued' THEN
        receipt_key_hex := current_setting(
            'app.campaign_template_design_retry_key_hash',
            true
        );
        IF receipt_key_hex IS NULL
           OR receipt_key_hex !~ '^[0-9a-f]{64}$'
           OR NOT EXISTS (
                SELECT 1
                  FROM campaign_template_design_mutations AS mutation
                 WHERE mutation.tenant_id = NEW.tenant_id
                   AND mutation.draft_id = NEW.id
                   AND mutation.operation = 'retry'
                   AND mutation.idempotency_key_hash =
                       decode(receipt_key_hex, 'hex')
                   AND mutation.registered_attempt_count =
                       OLD.attempt_count
           ) THEN
            RAISE EXCEPTION
                'campaign template design retry requires an atomic receipt'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_template_design_retry_receipt_guard
    BEFORE UPDATE ON campaign_template_design_drafts
    FOR EACH ROW
    EXECUTE FUNCTION enforce_campaign_template_design_retry_receipt();

COMMIT;
