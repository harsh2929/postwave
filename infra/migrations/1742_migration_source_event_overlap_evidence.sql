-- 1742_migration_source_event_overlap_evidence.sql
--
-- Durable proof that source-event replay stayed healthy throughout a cutover
-- overlap. Legacy monitor timestamps are deliberately not backfilled: a prior
-- one-shot sync cannot be promoted into continuous-overlap evidence.

BEGIN;

ALTER TABLE migration_source_event_monitors
    ADD COLUMN IF NOT EXISTS enabled_since timestamptz,
    ADD COLUMN IF NOT EXISTS first_successful_sync_at timestamptz,
    ADD COLUMN IF NOT EXISTS successful_sync_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_success_gap_seconds integer NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'migration_source_event_monitors_successful_sync_count_nonnegative'
           AND conrelid = 'migration_source_event_monitors'::regclass
    ) THEN
        ALTER TABLE migration_source_event_monitors
            ADD CONSTRAINT migration_source_event_monitors_successful_sync_count_nonnegative
            CHECK (successful_sync_count >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'migration_source_event_monitors_max_success_gap_nonnegative'
           AND conrelid = 'migration_source_event_monitors'::regclass
    ) THEN
        ALTER TABLE migration_source_event_monitors
            ADD CONSTRAINT migration_source_event_monitors_max_success_gap_nonnegative
            CHECK (max_success_gap_seconds >= 0);
    END IF;
END $$;

COMMIT;
