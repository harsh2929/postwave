-- 0290_subscriber_tags_join.sql
--
-- Tags refinement 1/12 — normalised (subscriber, tag) join table.
--
-- Tag application has lived on subscribers.tags (text[] since 0003)
-- since day one. That column is fine for "which tags does this
-- subscriber carry" but cannot answer:
--
--   * who applied this tag, when, from which surface (analytics,
--     audit, history, hierarchy);
--   * how many subscribers carry tag X without unnest+GROUP BY over
--     the whole subscribers table (slow on 100k-row tenants);
--   * atomic merge / rename that survives a concurrent UPDATE on
--     the same row.
--
-- This migration introduces subscriber_tags(tenant_id, subscriber_id,
-- tag_id, applied_at, applied_by, source) with a FK to tags(id) and
-- subscribers(id), backfills from the legacy text[], and enables
-- dual-write. A later migration drops the legacy column.
--
-- Backfill auto-registers orphan tags (used on a subscriber but
-- never inserted into the canonical tags table) so the FK can hold.
-- Re-running the migration is a no-op via ON CONFLICT.

BEGIN;

-- 1. Backfill any orphan tag labels into the canonical tags table.
--    The join FK below requires every text[] entry to resolve to a
--    tags row, so register the missing ones with default color and
--    empty description.
INSERT INTO tags (tenant_id, name)
SELECT DISTINCT s.tenant_id, lower(trim(both ' ' from u))::citext AS name
  FROM subscribers s,
       unnest(s.tags) AS u
 WHERE s.tags IS NOT NULL
   AND length(trim(both ' ' from u)) > 0
ON CONFLICT (tenant_id, name) DO NOTHING;

-- 2. The join table.
CREATE TABLE IF NOT EXISTS subscriber_tags (
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    tag_id        uuid        NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    applied_by    uuid,
    source        text        NOT NULL DEFAULT 'manual',
    PRIMARY KEY (tenant_id, subscriber_id, tag_id),
    CHECK (length(source) BETWEEN 1 AND 32)
);

COMMENT ON TABLE subscriber_tags IS
    'Normalised (subscriber, tag) application with provenance. Dual-written alongside subscribers.tags (text[]) until cutover.';

-- 3. Indexes.
--    * tag-side lookup ("who carries tag X?") — the hot path for
--      analytics, segments, the tag-detail slideover.
CREATE INDEX IF NOT EXISTS subscriber_tags_tag_idx
    ON subscriber_tags (tenant_id, tag_id, applied_at DESC);
--    * subscriber-side lookup ("what tags does this contact have?")
--      — used by audit views + per-subscriber timeline.
CREATE INDEX IF NOT EXISTS subscriber_tags_subscriber_idx
    ON subscriber_tags (tenant_id, subscriber_id);

-- 4. Backfill the join table from the existing text[] column. The
--    JOIN to tags is safe because step 1 guaranteed every label has
--    a registry row. lower(trim()) matches the citext column's
--    case-insensitive equality semantics.
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, source, applied_at)
SELECT s.tenant_id,
       s.id,
       t.id,
       'backfill',
       COALESCE(s.created_at, now())
  FROM subscribers s
 CROSS JOIN LATERAL unnest(s.tags) AS u
  JOIN tags t
    ON t.tenant_id = s.tenant_id
   AND t.name      = lower(trim(both ' ' from u))::citext
 WHERE s.tags IS NOT NULL
   AND length(trim(both ' ' from u)) > 0
ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING;

-- 5. Grants + RLS. Follow the canonical NULLIF idiom so a missing
--    app.tenant_id GUC fails closed instead of crashing on the
--    empty-string-to-uuid cast.
GRANT SELECT, INSERT, DELETE ON subscriber_tags TO postwave_app;

ALTER TABLE subscriber_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_tags FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_tags;
CREATE POLICY tenant_isolation ON subscriber_tags
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON subscriber_tags;
CREATE POLICY tenant_visible ON subscriber_tags
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
