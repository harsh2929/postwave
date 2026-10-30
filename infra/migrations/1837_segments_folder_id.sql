-- 1837_segments_folder_id.sql
--
-- SEG-038 — the segment_folders registry (migration 1237) and its
-- ON-DELETE-SET-NULL folder_id already exist on saved_segments, but the
-- BUILDER segments table (the one the web Segments list actually renders) has
-- no way to be filed under a folder. So the shipped folders feature is
-- unreachable from the surface users see. This adds a nullable folder_id to
-- `segments` referencing the SAME per-tenant segment_folders registry, so a
-- folder can organize both saved bookmarks and builder segments.
--
-- The FK is TENANT-SCOPED (composite (tenant_id, folder_id)), mirroring
-- migration 1759. A single-column `REFERENCES segment_folders(id)` would let a
-- tenant file a segment under ANOTHER tenant's folder, because Postgres
-- referential-integrity checks bypass RLS and would only verify global
-- existence. The composite key closes that cross-tenant hole.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive nullable column + composite FK + index + a unique
-- key on segment_folders(tenant_id,id). Older code never selects folder_id.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Composite-FK target: segment_folders needs a UNIQUE (tenant_id, id) so a
-- tenant-scoped FK can reference it. It currently has only PK(id) +
-- UNIQUE(tenant_id, name). The table is a small per-tenant folder registry, so
-- a brief lock to build this unique constraint is acceptable.
ALTER TABLE segment_folders
    ADD CONSTRAINT segment_folders_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS folder_id uuid;

-- Tenant-scoped composite FK (mirrors migration 1759). ON DELETE SET NULL uses
-- the column-list form so ONLY folder_id is nulled when a folder is deleted —
-- tenant_id stays NOT NULL.
ALTER TABLE segments
    ADD CONSTRAINT segments_tenant_folder_fkey
    FOREIGN KEY (tenant_id, folder_id)
    REFERENCES segment_folders (tenant_id, id)
    ON DELETE SET NULL (folder_id);

COMMIT;

-- PostgreSQL cannot build a concurrent index inside a transaction. Build the
-- folder-grouping index CONCURRENTLY, after the column is committed, so the
-- online segments table is never blocked on large installations.
CREATE INDEX CONCURRENTLY IF NOT EXISTS segments_tenant_folder_idx
    ON segments (tenant_id, folder_id);
