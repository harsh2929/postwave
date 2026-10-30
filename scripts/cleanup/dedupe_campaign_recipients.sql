-- scripts/cleanup/dedupe_campaign_recipients.sql
--
-- One-shot dedupe of campaign_recipients before migration 0158
-- (campaign_recipients_campaign_email_uniq) is applied. Run as a
-- separate, audited step OUTSIDE the goose-style migration runner:
-- DELETE in a schema migration is blocked by the safety scanner
-- per infra/migrations/README.md.
--
-- Strategy: for each (campaign_id, lower(email)) group, keep the
-- EARLIEST id (smallest id). The earlier row is the one that any
-- existing send-loop state already points to, so retaining it
-- preserves status/error fields.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/cleanup/dedupe_campaign_recipients.sql
--
-- Run BEFORE applying migration 0158. Idempotent (re-running is a no-op).

BEGIN;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY campaign_id, lower(subscriber_email)
           ORDER BY id
         ) AS rn
    FROM campaign_recipients
)
DELETE FROM campaign_recipients
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Sanity check: no remaining duplicates.
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count
    FROM (
      SELECT campaign_id, lower(subscriber_email)
        FROM campaign_recipients
       GROUP BY 1, 2
      HAVING COUNT(*) > 1
    ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'dedup left % duplicates — refusing to commit', dup_count;
  END IF;
END $$;

COMMIT;
