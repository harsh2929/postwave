-- 1812_migration_job_label.sql
-- MIGR-037: let operators name/annotate a migration. Two nullable free-text
-- columns on migration_jobs so two same-source/same-day attempts are
-- distinguishable in the UI. Written only by a dedicated annotations UPDATE
-- (jobstore.UpdateAnnotations) — the general Update never touches them, so the
-- worker's lifecycle writes can't clobber an operator's label. RLS unchanged
-- (tenant_isolation already scopes migration_jobs).

ALTER TABLE migration_jobs
    ADD COLUMN IF NOT EXISTS label text,
    ADD COLUMN IF NOT EXISTS notes text;
