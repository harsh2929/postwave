-- 0291_tags_provenance_and_archive.sql
--
-- Tags refinement 2/12 — provenance + soft-delete columns on the
-- canonical tags table.
--
-- Adds:
--   * created_by  uuid          — actor who created the row (NULL for legacy)
--   * updated_at  timestamptz   — last-touched timestamp, stamped by Update
--   * updated_by  uuid          — actor who last touched the row
--   * archived_at timestamptz   — soft-delete state; List() hides archived
--                                 rows by default but the citext UNIQUE
--                                 (tenant_id, name) constraint still holds
--                                 so the namespace cannot be reused
--                                 (matches Braze).
--   * pii         boolean       — operator-set flag for PII-bearing tags
--                                 (e.g. "card_last4"); downstream uses can
--                                 redact / scope access without parsing
--                                 the name.
--
-- All columns are NULL-default; no backfill needed.

BEGIN;

ALTER TABLE tags
    ADD COLUMN IF NOT EXISTS created_by  uuid,
    ADD COLUMN IF NOT EXISTS updated_at  timestamptz,
    ADD COLUMN IF NOT EXISTS updated_by  uuid,
    ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS pii         boolean NOT NULL DEFAULT false;

-- Partial index over live rows is the hot path for List() in the UI.
CREATE INDEX IF NOT EXISTS tags_live_idx
    ON tags (tenant_id, name)
    WHERE archived_at IS NULL;

COMMIT;
