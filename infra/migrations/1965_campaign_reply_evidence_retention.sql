-- 1965_campaign_reply_evidence_retention.sql
--
-- F05 reply evidence used to retain body_snippet/body_stripped forever even
-- after the tenant's inbound-email retention sweep had redacted the original
-- inbound_emails body. That made the stated retention policy incomplete: the
-- same subscriber-authored content survived in a second table.
--
-- This migration gives every campaign reply two immutable digests:
--
--   * body_evidence_sha256 proves the exact bounded body fields that arrived;
--   * evidence_receipt_sha256 binds the normalized envelope, classification,
--     classifier receipt, and body digest into a durable v1 receipt.
--
-- The plaintext body may then make one irreversible transition to redacted.
-- The receipt and envelope survive. Ordinary application code loses table-wide
-- UPDATE/DELETE and receives only the two intended mutation capabilities:
-- one-way subscriber linking and one-way body redaction.
--
-- rollback-strategy: no-op (restoring erased body content is impossible and
-- weakening an evidence ledger after deployment is unsafe).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE campaign_replies
    ADD COLUMN IF NOT EXISTS body_evidence_sha256 text,
    ADD COLUMN IF NOT EXISTS evidence_contract_version text,
    ADD COLUMN IF NOT EXISTS evidence_receipt_sha256 text,
    ADD COLUMN IF NOT EXISTS body_redacted_at timestamptz;

CREATE OR REPLACE FUNCTION campaign_reply_body_evidence_sha256(
    p_body_snippet text,
    p_body_stripped text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT encode(
        public.digest(
            convert_to(
                jsonb_build_array(p_body_snippet, p_body_stripped)::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    )
$function$;

CREATE OR REPLACE FUNCTION campaign_reply_evidence_receipt_sha256(
    p_tenant_id uuid,
    p_campaign_id uuid,
    p_recipient_email text,
    p_in_reply_to text,
    p_subject text,
    p_raw_message_id text,
    p_source text,
    p_received_at timestamptz,
    p_metadata jsonb,
    p_classification text,
    p_body_evidence_sha256 text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT encode(
        public.digest(
            convert_to(
                jsonb_build_object(
                    'contract_version', 'postwave.campaign-reply-evidence.v1',
                    'tenant_id', p_tenant_id::text,
                    'campaign_id', COALESCE(p_campaign_id::text, ''),
                    'recipient_email_sha256', encode(
                        public.digest(
                            convert_to(lower(COALESCE(p_recipient_email, '')), 'UTF8'),
                            'sha256'
                        ),
                        'hex'
                    ),
                    'in_reply_to', COALESCE(p_in_reply_to, ''),
                    'subject', COALESCE(p_subject, ''),
                    'raw_message_id', COALESCE(p_raw_message_id, ''),
                    'source', p_source,
                    'received_at_epoch_us', floor(
                        extract(epoch FROM p_received_at) * 1000000
                    )::bigint,
                    'metadata', COALESCE(p_metadata, '{}'::jsonb),
                    'classification', COALESCE(p_classification, ''),
                    'body_evidence_sha256', p_body_evidence_sha256
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    )
$function$;

-- New rows get complete receipts before the bounded legacy backfill runs.
CREATE OR REPLACE FUNCTION campaign_replies_evidence_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    expected_body_hash text;
    expected_receipt_hash text;
BEGIN
    expected_body_hash := campaign_reply_body_evidence_sha256(
        COALESCE(NEW.body_snippet, ''), COALESCE(NEW.body_stripped, '')
    );
    IF NEW.body_evidence_sha256 IS NOT NULL
       AND NEW.body_evidence_sha256 <> expected_body_hash THEN
        RAISE EXCEPTION 'campaign reply body evidence digest mismatch'
            USING ERRCODE = '23514';
    END IF;
    NEW.body_evidence_sha256 := expected_body_hash;
    NEW.evidence_contract_version := 'postwave.campaign-reply-evidence.v1';

    expected_receipt_hash := campaign_reply_evidence_receipt_sha256(
        NEW.tenant_id,
        NEW.campaign_id,
        NEW.recipient_email::text,
        NEW.in_reply_to,
        NEW.subject,
        NEW.raw_message_id,
        NEW.source,
        NEW.received_at,
        NEW.metadata,
        NEW.classification,
        NEW.body_evidence_sha256
    );
    IF NEW.evidence_receipt_sha256 IS NOT NULL
       AND NEW.evidence_receipt_sha256 <> expected_receipt_hash THEN
        RAISE EXCEPTION 'campaign reply evidence receipt mismatch'
            USING ERRCODE = '23514';
    END IF;
    NEW.evidence_receipt_sha256 := expected_receipt_hash;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS campaign_replies_evidence_insert_guard
    ON campaign_replies;
CREATE TRIGGER campaign_replies_evidence_insert_guard
    BEFORE INSERT ON campaign_replies
    FOR EACH ROW EXECUTE FUNCTION campaign_replies_evidence_insert_guard();

-- Backfill before installing the mutation guard. COALESCE mirrors the insert
-- trigger and makes the digest shape independent of legacy NULL storage.
DO $backfill$
DECLARE
    rows_changed integer;
BEGIN
    LOOP
        WITH batch AS (
            SELECT id,
                   campaign_reply_body_evidence_sha256(
                       COALESCE(body_snippet, ''),
                       COALESCE(body_stripped, '')
                   ) AS body_hash
              FROM campaign_replies
             WHERE body_evidence_sha256 IS NULL
                OR evidence_contract_version IS NULL
                OR evidence_receipt_sha256 IS NULL
             ORDER BY received_at, id
             LIMIT 1000
             FOR UPDATE SKIP LOCKED
        )
        UPDATE campaign_replies AS reply
           SET body_evidence_sha256 = batch.body_hash,
               evidence_contract_version = 'postwave.campaign-reply-evidence.v1',
               evidence_receipt_sha256 = campaign_reply_evidence_receipt_sha256(
                   reply.tenant_id,
                   reply.campaign_id,
                   reply.recipient_email::text,
                   reply.in_reply_to,
                   reply.subject,
                   reply.raw_message_id,
                   reply.source,
                   reply.received_at,
                   reply.metadata,
                   reply.classification,
                   batch.body_hash
               )
          FROM batch
         WHERE reply.id = batch.id;
        GET DIAGNOSTICS rows_changed = ROW_COUNT;
        EXIT WHEN rows_changed = 0;
    END LOOP;
END
$backfill$;

ALTER TABLE campaign_replies
    ALTER COLUMN evidence_contract_version
        SET DEFAULT 'postwave.campaign-reply-evidence.v1';

ALTER TABLE campaign_replies
    DROP CONSTRAINT IF EXISTS campaign_replies_evidence_contract_check,
    ADD CONSTRAINT campaign_replies_evidence_contract_check CHECK (
        evidence_contract_version IS NOT NULL
        AND evidence_contract_version = 'postwave.campaign-reply-evidence.v1'
        AND body_evidence_sha256 IS NOT NULL
        AND body_evidence_sha256 ~ '^[0-9a-f]{64}$'
        AND evidence_receipt_sha256 IS NOT NULL
        AND evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS campaign_replies_body_redaction_shape_check,
    ADD CONSTRAINT campaign_replies_body_redaction_shape_check CHECK (
        body_redacted_at IS NULL
        OR (
            COALESCE(body_snippet, '') = ''
            AND COALESCE(body_stripped, '') = ''
        )
    ) NOT VALID;

ALTER TABLE campaign_replies
    VALIDATE CONSTRAINT campaign_replies_evidence_contract_check;
ALTER TABLE campaign_replies
    VALIDATE CONSTRAINT campaign_replies_body_redaction_shape_check;

CREATE OR REPLACE FUNCTION campaign_replies_evidence_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    subscriber_link boolean;
    body_redaction boolean;
BEGIN
    subscriber_link :=
        OLD.subscriber_id IS NULL
        AND NEW.subscriber_id IS NOT NULL;

    body_redaction :=
        OLD.body_redacted_at IS NULL
        AND NEW.body_redacted_at IS NOT NULL
        AND COALESCE(NEW.body_snippet, '') = ''
        AND COALESCE(NEW.body_stripped, '') = '';

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

    -- Every other field is immutable evidence. subscriber_id is deliberately
    -- excluded because a previously unknown sender may be linked later; its
    -- transition is constrained above and does not rewrite the ingest receipt.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
       OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to
       OR NEW.subject IS DISTINCT FROM OLD.subject
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

DROP TRIGGER IF EXISTS campaign_replies_evidence_update_guard
    ON campaign_replies;
CREATE TRIGGER campaign_replies_evidence_update_guard
    BEFORE UPDATE ON campaign_replies
    FOR EACH ROW EXECUTE FUNCTION campaign_replies_evidence_update_guard();

CREATE INDEX IF NOT EXISTS campaign_replies_body_retention_idx
    ON campaign_replies (tenant_id, received_at, id)
    WHERE body_redacted_at IS NULL
      AND (
          COALESCE(body_snippet, '') <> ''
          OR COALESCE(body_stripped, '') <> ''
      );

DROP POLICY IF EXISTS campaign_replies_retention_discovery
    ON campaign_replies;
CREATE POLICY campaign_replies_retention_discovery
    ON campaign_replies
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.retention_worker', true) = 'true'
    );

-- Migration 0150 granted full CRUD despite 0087 describing an append-only
-- ledger. Keep INSERT/SELECT, remove destructive authority, then add only the
-- two guarded column-level transitions used by production.
REVOKE UPDATE, DELETE ON campaign_replies FROM postwave_app;
GRANT UPDATE (subscriber_id, body_snippet, body_stripped, body_redacted_at)
    ON campaign_replies TO postwave_app;

REVOKE ALL ON FUNCTION campaign_reply_body_evidence_sha256(text, text)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_reply_evidence_receipt_sha256(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_replies_evidence_insert_guard()
    FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_replies_evidence_update_guard()
    FROM PUBLIC;

-- Trigger functions execute with the invoker's privileges. postwave_app must
-- be able to execute the two pure digest helpers during INSERT; they expose no
-- rows, elevate no scope, and accept only caller-supplied scalar values.
GRANT EXECUTE ON FUNCTION campaign_reply_body_evidence_sha256(text, text)
    TO postwave_app;
GRANT EXECUTE ON FUNCTION campaign_reply_evidence_receipt_sha256(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb, text, text
) TO postwave_app;
