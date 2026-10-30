-- 0249_list_subscribers_native_mirror.sql
--
-- GAP-LS-044: extend list_subscribers (0222) so the listmonk_events
-- webhook handler can mirror native Listmonk subscribe/unsubscribe
-- events into the Postwave-side membership join table. Today only the
-- bulk move-to-list path populates the table, which means per-list
-- analytics and segments under-count whenever a contact is added via
-- the native form/API/CSV path.
--
-- Why these columns:
--
--   - listmonk_list_id (bigint): Listmonk's list ids are bigint. To
--     mirror native events we have to know which Listmonk bigint id
--     a Postwave UUID list maps to. The (Postwave-uuid <-> Listmonk
--     bigint) mapping itself lives in list_id_map (separate
--     migration in this series). This column is the denormalized
--     bigint stored on the membership row so the listmonk_events
--     handler can INSERT without a second lookup.
--
--   - subscriber_id (uuid): already exists in 0222 as part of the PK.
--     No change here — referenced in the per-list health rewrite.
--
--   - email (citext): denormalized for fast list-health joins
--     (avoids a subscribers JOIN per row when sampling 100k+ list
--     members). Populated by the writer.
--
--   - source (form/api/csv/integration/admin/migration): supports
--     GAP-LS-063 list growth source attribution UI.
--
--   - source_id (text): provider's event id where available
--     (Listmonk's event id for native subscribes); idempotency
--     handle for replayed webhooks.
--
--   - removed_at (timestamptz): soft-delete column so the
--     "unsubscribed in last 30d from this list" segment predicate
--     works without a separate audit table.
--
-- Adding the id uuid PK upgrade (was composite PK in 0222) requires
-- care: we add an `id` column with default but keep the existing
-- composite PK as a UNIQUE constraint so foreign keys we add later
-- can point at the row-id. The composite PK is replaced by adding
-- an explicit UNIQUE index on the existing (tenant_id, list_id,
-- subscriber_id) tuple.

BEGIN;

-- 1. id column. Existing rows get a generated uuid via the DEFAULT,
--    then we add a UNIQUE index so the row can be referenced. We do
--    NOT replace the existing composite PK (tenant_id, list_id,
--    subscriber_id) — keeping it preserves the original FK target
--    and the lookup pattern bulk move-to-list uses today.
ALTER TABLE list_subscribers
    ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS list_subscribers_id_uniq
    ON list_subscribers (id);

-- 2. Denormalized columns.
ALTER TABLE list_subscribers
    ADD COLUMN IF NOT EXISTS listmonk_list_id bigint;

ALTER TABLE list_subscribers
    ADD COLUMN IF NOT EXISTS email citext;

ALTER TABLE list_subscribers
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'migration';

ALTER TABLE list_subscribers
    ADD COLUMN IF NOT EXISTS source_id text;

ALTER TABLE list_subscribers
    ADD COLUMN IF NOT EXISTS removed_at timestamptz;

-- Source CHECK — gated by DROP IF EXISTS so re-runs don't choke.
ALTER TABLE list_subscribers
    DROP CONSTRAINT IF EXISTS list_subscribers_source_check;
ALTER TABLE list_subscribers
    ADD CONSTRAINT list_subscribers_source_check
        CHECK (source IN ('form','api','csv','integration','admin','migration','listmonk_event'));

-- 3. Backfill email from subscribers join for existing rows. The
--    column is nullable so this is safe to skip on dev databases
--    that haven't seen the writer yet.
UPDATE list_subscribers ls
   SET email = s.email
  FROM subscribers s
 WHERE ls.subscriber_id = s.id
   AND ls.email IS NULL;

-- 4. Indexes for the new query patterns.
CREATE INDEX IF NOT EXISTS list_subscribers_tenant_email_idx
    ON list_subscribers (tenant_id, email)
    WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS list_subscribers_listmonk_list_idx
    ON list_subscribers (tenant_id, listmonk_list_id)
    WHERE listmonk_list_id IS NOT NULL;

-- Soft-delete partial: "removed in the last 30d" segment predicate.
CREATE INDEX IF NOT EXISTS list_subscribers_recent_removed_idx
    ON list_subscribers (tenant_id, list_id, removed_at DESC)
    WHERE removed_at IS NOT NULL;

-- Idempotency for replayed listmonk webhook events: same
-- (tenant, source, source_id) tuple must collapse to a single row.
CREATE UNIQUE INDEX IF NOT EXISTS list_subscribers_source_event_unique
    ON list_subscribers (tenant_id, source, source_id)
    WHERE source_id IS NOT NULL;

COMMIT;
