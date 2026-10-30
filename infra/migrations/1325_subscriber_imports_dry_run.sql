-- 1325_subscriber_imports_dry_run.sql
--
-- SUB-105: dry-run CSV import.
--
-- The Confirm endpoint always writes subscribers. Parity tools let an
-- operator preview the per-row OUTCOME of an import — full validation,
-- no database writes — before committing. This lands the persistence for
-- that "validate only" pass:
--
--   * dry_run          — when a Confirm carries {"dry_run": true} we flag
--                        the row so List/Get can surface that the last
--                        pass was a validation-only run.
--   * dry_run_results  — the row-by-row validation outcomes (email,
--                        outcome, error) plus the would-be created /
--                        updated / skipped / failed tallies, stored as
--                        JSONB so the wizard's Review step can render the
--                        preview without re-uploading.
--   * dry_run_at       — when the last dry-run pass completed.
--
-- A dry-run leaves status='preview' (nothing was queued / committed) so a
-- subsequent real Confirm still transitions preview → queued normally.
--
-- No new tables, so the existing 0134 tenant_visible RLS policy
-- (NULLIF(current_setting('app.tenant_id', true), '')::uuid OR
-- app.outbox_worker) keeps covering the rows.

BEGIN;

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS dry_run         boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS dry_run_results jsonb,
    ADD COLUMN IF NOT EXISTS dry_run_at      timestamptz;

COMMIT;
