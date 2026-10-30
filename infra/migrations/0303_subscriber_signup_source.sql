-- 0303_subscriber_signup_source.sql
--
-- Source-based automation filtering (archive-source-based-automation-filter,
-- P3). Buttondown filters subscribers and branches automations by where they
-- signed up — embedded form, hosted subscribe page, import, API, integration —
-- so welcome flows can fork on origin without manual tagging.
--
-- Before this migration, Postwave already tracks `consent_source` (a coarse
-- audit-quality field: double_optin / single_optin / import / api / unknown)
-- and `source_platform` (the migration-time provenance: 'mailchimp',
-- 'klaviyo', ...), but neither is what an operator wants when branching a
-- welcome flow. Consent_source conflates UX origin with legal mechanism, and
-- source_platform is only populated during one-shot migrations. Operators
-- need a stable, signup-time-only field they can read in the segment builder
-- and the automation trigger config.
--
-- 2026 SOTA references:
--   * Buttondown — "Signup source" facet (embedded form / hosted page /
--     import / API / integration) is a first-class filter on the subscribers
--     index page and a trigger condition on welcome automations.
--   * ConvertKit — "Signup form" filter on subscribers, plus per-form
--     welcome automations.
--   * Beehiiv — "Signup method" filter on subscribers.
--
-- Vocabulary pinned via CHECK constraint so unknown values from drifting
-- clients cannot silently land. Default 'unknown' lets the column be
-- backfilled lazily — every existing row gets 'unknown' on migrate, and the
-- next upsert from any code path that emits a real value overwrites it.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS signup_source text NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'subscribers_signup_source_chk'
    ) THEN
        ALTER TABLE subscribers
            ADD CONSTRAINT subscribers_signup_source_chk
            CHECK (signup_source IN (
                'embedded_form',
                'hosted_page',
                'import',
                'api',
                'integration',
                'unknown'
            ));
    END IF;
END$$;

-- Backfill from consent_source for existing rows so the column is useful on
-- day one without waiting for re-imports. This is a one-shot best-effort
-- mapping; it intentionally does NOT touch rows that have already been
-- written with a real value (defensive against re-run of the migration in a
-- test fixture).
UPDATE subscribers
   SET signup_source = CASE
       WHEN consent_source = 'import' THEN 'import'
       WHEN consent_source = 'api'    THEN 'api'
       WHEN consent_source IN ('double_optin', 'single_optin') THEN 'embedded_form'
       ELSE 'unknown'
   END
 WHERE signup_source = 'unknown';

-- Index for filter + automation-trigger lookups. Composite on (tenant_id,
-- signup_source) so the RLS-narrowed query plans use it directly without a
-- separate tenant lookup.
CREATE INDEX IF NOT EXISTS subscribers_tenant_signup_source_idx
    ON subscribers (tenant_id, signup_source);

COMMIT;
