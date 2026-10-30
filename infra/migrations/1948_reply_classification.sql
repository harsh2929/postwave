-- Reply classification and body processing (PRD F05 §7.3, §7.4).
--
-- `campaign_replies` had no classification column at all, so the PRD's central
-- rule — "auto-replies must never count as engagement" — had nowhere to be
-- recorded, and every reader of the table counted every persisted row.
--
-- Five readers count these: A/B winner selection, the engagement score that
-- feeds AI-surfacing, the Mailchimp compat surface, and two reply-analytics
-- endpoints. Until this column exists, all five are counting out-of-office
-- notices as human engagement — and a reply metric that does so improves the
-- more recipients are on holiday.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE campaign_replies
    ADD COLUMN IF NOT EXISTS classification text,
    -- The stripped body is what a human reads and what a classifier should see;
    -- the raw body is evidence. The PRD asks for both because stripping is
    -- heuristic: when it goes wrong, the only way to find out is to compare.
    ADD COLUMN IF NOT EXISTS body_stripped text,
    ADD COLUMN IF NOT EXISTS classified_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'campaign_replies'::regclass
           AND conname = 'campaign_replies_classification_check'
    ) THEN
        -- NULL is permitted and MEANINGFUL: it is a row that predates
        -- classification. Backfilling it to 'human_reply' would silently assert
        -- that every historical reply was human, which is the claim this column
        -- exists to stop being made by default.
        ALTER TABLE campaign_replies
            ADD CONSTRAINT campaign_replies_classification_check
            CHECK (classification IS NULL OR classification = ANY (ARRAY[
                'human_reply'::text, 'auto_reply'::text, 'out_of_office'::text,
                'bounce'::text, 'unsubscribe_request'::text, 'challenge_response'::text
            ])) NOT VALID;
    END IF;
END
$$;

ALTER TABLE campaign_replies VALIDATE CONSTRAINT campaign_replies_classification_check;

-- The engagement read: only human replies, and the partial index says so.
CREATE INDEX IF NOT EXISTS campaign_replies_engagement_idx
    ON campaign_replies (tenant_id, campaign_id, received_at DESC)
    WHERE classification = 'human_reply';

CREATE INDEX IF NOT EXISTS campaign_replies_classification_idx
    ON campaign_replies (tenant_id, classification);
