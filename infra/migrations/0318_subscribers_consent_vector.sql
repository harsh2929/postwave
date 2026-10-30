-- 0318_subscribers_consent_vector.sql
--
-- Per-purpose consent state-of-record on subscribers.
--
-- Why this migration:
--   consent_events (0094) is an append-only ledger — to answer
--   "is this subscriber consented for ai_processing right now?"
--   the send path would have to fold the entire per-subject event
--   stream. That's O(events) per send. GDPR/CPRA/Quebec Law 25/India
--   DPDP all require per-purpose state-of-record at activation time,
--   queryable in O(1).
--
--   This migration surfaces five purposes the engine actually gates
--   on as nullable timestamptz columns on subscribers:
--
--     consent_email_marketing_at   — email marketing channel
--     consent_sms_marketing_at     — SMS marketing channel
--     consent_profiling_at         — analytics / engagement scoring
--     consent_targeted_ads_at      — sale_share / targeted_advertising
--     consent_ai_processing_at     — LLM features (aicompose, etc.)
--
--   NULL = no recorded consent (treat as denied for non-essential
--   purposes). Non-NULL = timestamp of the last 'granted' event for
--   that (subject, category) pair. A subsequent 'revoked' or
--   'denied' resets the column to NULL.
--
--   A BEFORE INSERT trigger on consent_events maintains the columns
--   inside the same tx as the event write. The subscriber lookup
--   uses subject_id::uuid first, falling back to subject_email
--   (citext) — matching the consent_events shape.
--
--   The category-to-column map intentionally collapses:
--     marketing            -> consent_email_marketing_at
--     email_marketing      -> consent_email_marketing_at
--     analytics            -> consent_profiling_at
--     sale_share           -> consent_targeted_ads_at
--     targeted_advertising -> consent_targeted_ads_at
--     ai_processing        -> consent_ai_processing_at
--   SMS opt-in is recorded as a separate sms_consent_events row
--   today, but the column is added now so the SMS gate can read it
--   uniformly once the SMS writer dual-writes.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS consent_email_marketing_at timestamptz,
    ADD COLUMN IF NOT EXISTS consent_sms_marketing_at   timestamptz,
    ADD COLUMN IF NOT EXISTS consent_profiling_at       timestamptz,
    ADD COLUMN IF NOT EXISTS consent_targeted_ads_at    timestamptz,
    ADD COLUMN IF NOT EXISTS consent_ai_processing_at   timestamptz;

-- Partial indexes for the common "give me everyone currently
-- consented for purpose X" segment query. NULLs are excluded
-- because segments asking "consent.ai_processing = true" only
-- want the granted set.
CREATE INDEX IF NOT EXISTS subscribers_consent_email_marketing_idx
    ON subscribers (tenant_id, consent_email_marketing_at)
    WHERE consent_email_marketing_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscribers_consent_sms_marketing_idx
    ON subscribers (tenant_id, consent_sms_marketing_at)
    WHERE consent_sms_marketing_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscribers_consent_profiling_idx
    ON subscribers (tenant_id, consent_profiling_at)
    WHERE consent_profiling_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscribers_consent_targeted_ads_idx
    ON subscribers (tenant_id, consent_targeted_ads_at)
    WHERE consent_targeted_ads_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscribers_consent_ai_processing_idx
    ON subscribers (tenant_id, consent_ai_processing_at)
    WHERE consent_ai_processing_at IS NOT NULL;

-- Trigger function: project a consent_events row onto the
-- subscriber state-of-record. Runs inside the writer's tx so the
-- column flip and the event row are atomic.
--
-- 'granted' / 'imported' → stamp now (or NEW.created_at if set)
-- 'denied' / 'revoked' / 'opted_out' → NULL the column
--
-- Resolution order for the subscriber row:
--   1. NEW.subject_id::uuid (if it parses as uuid) AND
--      subject_type='subscriber'
--   2. NEW.subject_email matched against subscribers.email
--      regardless of subject_type — visitor-banner events that
--      identified later still update the linked subscriber.
--
-- A missed lookup (visitor with no subscriber row yet) is a no-op:
-- the consent_events row is still written by the caller; the
-- vector column gets filled by the subsequent identify/upsert
-- when the visitor → subscriber transition happens (or on a
-- backfill run).
CREATE OR REPLACE FUNCTION consent_events_project_to_subscribers()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    column_name text;
    stamp_value timestamptz;
    is_grant    boolean;
    sub_uuid    uuid;
BEGIN
    -- Map category → vector column. Unknown categories (e.g.
    -- 'essential', 'email_tracking', 'sensitive_data') don't
    -- have a dedicated column and are skipped.
    column_name := CASE NEW.category
        WHEN 'email_marketing'      THEN 'consent_email_marketing_at'
        WHEN 'marketing'            THEN 'consent_email_marketing_at'
        WHEN 'analytics'            THEN 'consent_profiling_at'
        WHEN 'sale_share'           THEN 'consent_targeted_ads_at'
        WHEN 'targeted_advertising' THEN 'consent_targeted_ads_at'
        WHEN 'ai_processing'        THEN 'consent_ai_processing_at'
        ELSE NULL
    END;

    IF column_name IS NULL THEN
        RETURN NEW;
    END IF;

    is_grant := NEW.action IN ('granted', 'imported');
    IF is_grant THEN
        stamp_value := COALESCE(NEW.created_at, now());
    ELSE
        stamp_value := NULL;
    END IF;

    -- Try uuid subject id first (subject_type='subscriber' path).
    BEGIN
        sub_uuid := NEW.subject_id::uuid;
    EXCEPTION WHEN others THEN
        sub_uuid := NULL;
    END;

    IF sub_uuid IS NOT NULL THEN
        EXECUTE format(
            'UPDATE subscribers SET %I = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3',
            column_name
        ) USING stamp_value, NEW.tenant_id, sub_uuid;
    END IF;

    -- Always also try the email path. Belt-and-braces: most
    -- consent_events writes carry subject_email AND the visitor
    -- -> subscriber linkage might be established via either id.
    IF NEW.subject_email IS NOT NULL THEN
        EXECUTE format(
            'UPDATE subscribers SET %I = $1, updated_at = now() WHERE tenant_id = $2 AND email = $3',
            column_name
        ) USING stamp_value, NEW.tenant_id, NEW.subject_email;
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS consent_events_project_vector ON consent_events;
CREATE TRIGGER consent_events_project_vector
    AFTER INSERT ON consent_events
    FOR EACH ROW
    EXECUTE FUNCTION consent_events_project_to_subscribers();

-- Backfill from the existing event ledger. For every (subscriber,
-- mapped category) pair, fold the event stream and project the
-- terminal state. ORDER BY created_at DESC + DISTINCT ON gives
-- us the most-recent event per pair.
WITH ranked AS (
    SELECT DISTINCT ON (e.tenant_id, s.id, e.category)
           e.tenant_id,
           s.id AS subscriber_id,
           e.category,
           e.action,
           e.created_at
      FROM consent_events e
      JOIN subscribers s
        ON s.tenant_id = e.tenant_id
       AND (s.id::text = e.subject_id OR s.email = e.subject_email)
     WHERE e.category IN ('email_marketing','marketing','analytics',
                          'sale_share','targeted_advertising','ai_processing')
     ORDER BY e.tenant_id, s.id, e.category, e.created_at DESC
)
UPDATE subscribers s SET
    consent_email_marketing_at = CASE
        WHEN r.category IN ('email_marketing','marketing') AND r.action IN ('granted','imported')
            THEN r.created_at
        WHEN r.category IN ('email_marketing','marketing')
            THEN NULL
        ELSE s.consent_email_marketing_at
    END,
    consent_profiling_at = CASE
        WHEN r.category = 'analytics' AND r.action IN ('granted','imported')
            THEN r.created_at
        WHEN r.category = 'analytics'
            THEN NULL
        ELSE s.consent_profiling_at
    END,
    consent_targeted_ads_at = CASE
        WHEN r.category IN ('sale_share','targeted_advertising') AND r.action IN ('granted','imported')
            THEN r.created_at
        WHEN r.category IN ('sale_share','targeted_advertising')
            THEN NULL
        ELSE s.consent_targeted_ads_at
    END,
    consent_ai_processing_at = CASE
        WHEN r.category = 'ai_processing' AND r.action IN ('granted','imported')
            THEN r.created_at
        WHEN r.category = 'ai_processing'
            THEN NULL
        ELSE s.consent_ai_processing_at
    END
  FROM ranked r
 WHERE s.id = r.subscriber_id AND s.tenant_id = r.tenant_id;

COMMENT ON COLUMN subscribers.consent_email_marketing_at IS
    'State-of-record for email marketing consent. NULL = no recorded grant. Updated by consent_events trigger on category in (email_marketing,marketing).';
COMMENT ON COLUMN subscribers.consent_sms_marketing_at IS
    'State-of-record for SMS marketing consent. NULL = no recorded grant. Awaiting SMS writer dual-write.';
COMMENT ON COLUMN subscribers.consent_profiling_at IS
    'State-of-record for analytics/engagement profiling consent. NULL = no recorded grant. Updated by consent_events trigger on category=analytics.';
COMMENT ON COLUMN subscribers.consent_targeted_ads_at IS
    'State-of-record for sale/share + targeted-advertising consent. NULL = no recorded grant. Updated by consent_events trigger on category in (sale_share,targeted_advertising).';
COMMENT ON COLUMN subscribers.consent_ai_processing_at IS
    'State-of-record for LLM/AI processing consent. NULL = no recorded grant. Updated by consent_events trigger on category=ai_processing.';

COMMIT;
