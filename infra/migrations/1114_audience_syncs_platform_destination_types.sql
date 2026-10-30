-- 1114_audience_syncs_platform_destination_types.sql
--
-- SUB-113 (Native ad-platform audience sync): widen the
-- audience_syncs.destination_type CHECK so credentialed Custom-Audience
-- destinations (Meta / Google Ads / TikTok / LinkedIn / Snap) can be
-- created and run end-to-end through the runner's platform-adapter path
-- (apps/api/internal/audience_destinations/platform_adapter.go).
--
-- Background: 0376 created the table with destination_type webhook-only
-- (CHECK (destination_type IN ('webhook'))) and noted the constraint is
-- "widened when a new destination type lands" — this is that widening.
--
-- Two changes, both additive:
--
--   1. Widen the destination_type CHECK to the full destination set. The
--      table is already tenant-RLS protected (tenant_isolation +
--      worker-select policies from 0376); altering a CHECK constraint
--      preserves those policies, so no RLS work is needed here. The
--      constraint created inline on the column in 0376 is named by
--      Postgres as <table>_<column>_check; we DROP IF EXISTS that name and
--      re-add an explicitly-named constraint covering the full set.
--
--   2. Add destination_config jsonb so a platform destination can persist
--      the adapter settings it needs (audience id, account id, the
--      credential reference). Webhook destinations leave it '{}'. The
--      runner reads it and hands it to the PlatformAdapter at run time
--      (Config is NEVER returned by the read API unmasked — credentials
--      stay server-side). ADD COLUMN ... NOT NULL DEFAULT '{}'::jsonb is a
--      constant default → lock-minimal on PG 11+.
--
-- Both statements are IF EXISTS / IF NOT EXISTS, so the migration is
-- idempotent and rollback-safe (prior releases reject the new types at
-- the application layer and ignore the extra column).

BEGIN;

ALTER TABLE audience_syncs
    DROP CONSTRAINT IF EXISTS audience_syncs_destination_type_check;

ALTER TABLE audience_syncs
    ADD CONSTRAINT audience_syncs_destination_type_check
    CHECK (destination_type IN (
        'webhook',
        'meta',
        'google_ads',
        'tiktok',
        'linkedin',
        'snap'
    ));

ALTER TABLE audience_syncs
    ADD COLUMN IF NOT EXISTS destination_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
