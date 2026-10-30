-- 0158_campaign_recipients_unique.sql
--
-- Forward-fix for D1 (PRODUCTION_READINESS.md):
-- QueueAndStartCampaign bare-INSERTs into campaign_recipients
-- without an ON CONFLICT clause. A second /queue call (network
-- retry, operator double-click, paused→queue cycle, approval hook
-- race) inserts duplicate (campaign_id, subscriber_email) rows
-- that the send loop processes independently — subscribers
-- receive the same campaign twice.
--
-- Fix: add a partial unique index that lets ON CONFLICT DO NOTHING
-- become a no-op for the duplicate INSERT in the caller. Existing
-- duplicate rows (from pre-fix runs) MUST be deduped first via an
-- audited resumable job — the migration safety scanner blocks
-- DELETE inside a schema migration per the contract in
-- infra/migrations/README.md. See scripts/cleanup/dedupe_campaign_recipients.sql
-- for the precheck.

BEGIN;

-- Lower(email) so case-only differences don't slip through.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_campaign_email_uniq
    ON campaign_recipients (campaign_id, lower(subscriber_email));

COMMIT;
