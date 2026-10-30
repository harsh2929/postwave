-- 0413_subscriber_name_columns.sql
--
-- SUB-004 — First/last/full/display name columns.
--
-- Names already live in subscribers.merge_fields (Mailchimp keys FNAME /
-- LNAME) and custom_fields (Klaviyo keys first_name / last_name), and the
-- search_tsv GENERATED column (migration 0242) already indexes both. But
-- jsonb-only names cannot be sorted, deduped, or driven into picker UIs
-- without a full table scan + per-row jsonb extraction. Klaviyo, Mailchimp,
-- and Beehiiv all expose first/last name as first-class, sortable subscriber
-- columns.
--
-- This migration promotes names to first-class columns:
--   * first_name    — given name (Mailchimp FNAME / Klaviyo first_name)
--   * last_name     — family name (Mailchimp LNAME / Klaviyo last_name)
--   * full_name     — "first last" convenience column
--   * display_name  — operator/UI-facing label (may differ from full_name)
--
-- All four are `text NOT NULL DEFAULT ''` so existing rows get a stable
-- empty string (never NULL) and the columns are always safe to SELECT +
-- ORDER BY without COALESCE noise. The application upsert path (Go handlers)
-- populates them from merge_fields / custom_fields; this migration does not
-- install triggers.
--
-- A compound sort index on (tenant_id, first_name, last_name) serves the
-- RLS-narrowed alphabetical ordering used by sort=first_name / sort=last_name
-- as a single index range scan.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS first_name   text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS last_name    text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS full_name    text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';

-- Best-effort one-shot backfill from the jsonb name variants so the columns
-- are useful on day one without waiting for the next upsert. Mailchimp keys
-- (merge_fields.FNAME / .LNAME) take precedence; Klaviyo keys
-- (custom_fields.first_name / .last_name) fill the gap. Only touches rows
-- that are still at the default empty string (idempotent re-run safe).
UPDATE subscribers
   SET first_name = COALESCE(
           NULLIF(merge_fields ->> 'FNAME', ''),
           NULLIF(custom_fields ->> 'first_name', ''),
           ''
       ),
       last_name = COALESCE(
           NULLIF(merge_fields ->> 'LNAME', ''),
           NULLIF(custom_fields ->> 'last_name', ''),
           ''
       )
 WHERE first_name = '' AND last_name = '';

-- Derive full_name / display_name from the freshly backfilled first/last.
UPDATE subscribers
   SET full_name = btrim(first_name || ' ' || last_name),
       display_name = CASE
           WHEN btrim(first_name || ' ' || last_name) <> ''
               THEN btrim(first_name || ' ' || last_name)
           ELSE display_name
       END
 WHERE full_name = ''
   AND (first_name <> '' OR last_name <> '');

-- Composite index for alphabetical ordering. (tenant_id, first_name,
-- last_name) so the RLS-narrowed list query orders by name without a
-- separate tenant lookup or a sort node.
CREATE INDEX IF NOT EXISTS subscribers_tenant_name_idx
    ON subscribers (tenant_id, first_name, last_name);

COMMIT;
