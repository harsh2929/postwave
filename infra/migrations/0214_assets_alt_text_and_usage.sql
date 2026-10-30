-- 0214_assets_alt_text_and_usage.sql
--
-- Refined Library (PR 1): adds alt_text for accessibility, references_count
-- for in-place "Used in N places" chips, and last_used_at to power the
-- "Recently used" smart filter. All additive and default-safe; existing
-- rows backfill cleanly (alt_text='', references_count=0, last_used_at=NULL).

BEGIN;

ALTER TABLE assets
    ADD COLUMN alt_text         text       NOT NULL DEFAULT '',
    ADD COLUMN references_count int        NOT NULL DEFAULT 0,
    ADD COLUMN last_used_at     timestamptz;

CREATE INDEX assets_tenant_refs_idx ON assets (tenant_id, references_count DESC);

COMMIT;
