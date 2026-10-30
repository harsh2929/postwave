-- 1974_campaign_reply_identity_erasure.sql
--
-- F05 governed subject/envelope erasure.
--
-- Migration 1965 made a reply's body one-way redactable but declared
-- recipient_email and subject immutable evidence, and the GDPR erasure path in
-- internal/privacy never touched campaign_replies at all. The result: a data
-- subject who exercised their right to erasure kept their reply address and
-- subject line in the ledger indefinitely, while every other table holding the
-- same identity was placeholdered.
--
-- This adds the third and final one-way transition on this table. The design
-- mirrors body redaction rather than deletion because the row is evidence: the
-- receipt digests computed at ingest (body_evidence_sha256 and
-- evidence_receipt_sha256) are deliberately NOT recomputed, so the receipt
-- still proves exactly what arrived while the plaintext identity is gone. A
-- rewritten receipt would be indistinguishable from a forged one.
--
-- What is erased: recipient_email (the envelope) and subject. What survives:
-- the correlation evidence (in_reply_to, raw_message_id, source, received_at),
-- the classification receipt, and the digests. metadata is left alone because
-- the reply writer already stores header NAMES with empty values precisely so
-- user-controlled address text never lands there.
--
-- rollback-strategy: no-op (restoring erased identity is impossible and
-- reversing an erasure would defeat its purpose).

ALTER TABLE campaign_replies
    ADD COLUMN IF NOT EXISTS identity_redacted_at timestamptz;

-- Once redacted, no plaintext identity may remain. recipient_email is NOT NULL,
-- so erasure substitutes the same non-routable placeholder domain the
-- subscriber erasure path uses (erased+<token>@erased.invalid) rather than
-- attempting a NULL the column cannot hold.
ALTER TABLE campaign_replies
    DROP CONSTRAINT IF EXISTS campaign_replies_identity_redaction_shape_check,
    ADD CONSTRAINT campaign_replies_identity_redaction_shape_check CHECK (
        identity_redacted_at IS NULL
        OR (
            recipient_email::text LIKE '%@erased.invalid'
            AND COALESCE(subject, '') = ''
        )
    ) NOT VALID;

ALTER TABLE campaign_replies
    VALIDATE CONSTRAINT campaign_replies_identity_redaction_shape_check;

CREATE OR REPLACE FUNCTION campaign_replies_evidence_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    subscriber_link boolean;
    body_redaction boolean;
    identity_redaction boolean;
BEGIN
    subscriber_link :=
        OLD.subscriber_id IS NULL
        AND NEW.subscriber_id IS NOT NULL;

    body_redaction :=
        OLD.body_redacted_at IS NULL
        AND NEW.body_redacted_at IS NOT NULL
        AND COALESCE(NEW.body_snippet, '') = ''
        AND COALESCE(NEW.body_stripped, '') = '';

    -- One-way, and only ever toward the placeholder. Requiring the erased
    -- domain here as well as in the CHECK means a caller cannot rewrite the
    -- envelope to another real address under cover of "erasure".
    identity_redaction :=
        OLD.identity_redacted_at IS NULL
        AND NEW.identity_redacted_at IS NOT NULL
        AND NEW.recipient_email::text LIKE '%@erased.invalid'
        AND COALESCE(NEW.subject, '') = '';

    IF NOT subscriber_link
       AND NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id THEN
        RAISE EXCEPTION 'campaign reply subscriber linkage is one-way'
            USING ERRCODE = '55000';
    END IF;
    IF NOT body_redaction
       AND (
           NEW.body_snippet IS DISTINCT FROM OLD.body_snippet
           OR NEW.body_stripped IS DISTINCT FROM OLD.body_stripped
           OR NEW.body_redacted_at IS DISTINCT FROM OLD.body_redacted_at
       ) THEN
        RAISE EXCEPTION 'campaign reply body mutation must be one-way redaction'
            USING ERRCODE = '55000';
    END IF;
    IF NOT identity_redaction
       AND (
           NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
           OR NEW.subject IS DISTINCT FROM OLD.subject
           OR NEW.identity_redacted_at IS DISTINCT FROM OLD.identity_redacted_at
       ) THEN
        RAISE EXCEPTION 'campaign reply identity mutation must be one-way erasure'
            USING ERRCODE = '55000';
    END IF;

    -- Every other field is immutable evidence. subscriber_id, the body columns
    -- and the identity columns are excluded because their transitions are
    -- constrained above; none of them rewrites the ingest receipt.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to
       OR NEW.raw_message_id IS DISTINCT FROM OLD.raw_message_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.classification IS DISTINCT FROM OLD.classification
       OR NEW.classified_at IS DISTINCT FROM OLD.classified_at
       OR NEW.body_evidence_sha256 IS DISTINCT FROM OLD.body_evidence_sha256
       OR NEW.evidence_contract_version IS DISTINCT FROM OLD.evidence_contract_version
       OR NEW.evidence_receipt_sha256 IS DISTINCT FROM OLD.evidence_receipt_sha256 THEN
        RAISE EXCEPTION 'campaign reply evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$function$;

-- Extend the column-level authority by exactly the three columns the erasure
-- transition writes. UPDATE on the table as a whole stays revoked.
GRANT UPDATE (recipient_email, subject, identity_redacted_at)
    ON campaign_replies TO postwave_app;

-- Discovery index for erasure: find a subject's un-erased replies without
-- scanning the ledger.
CREATE INDEX IF NOT EXISTS campaign_replies_identity_erasure_idx
    ON campaign_replies (tenant_id, recipient_email)
    WHERE identity_redacted_at IS NULL;
