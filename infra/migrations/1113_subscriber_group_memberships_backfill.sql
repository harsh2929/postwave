-- 1113_subscriber_group_memberships_backfill.sql
--
-- SUB-117 — backfill subscriber_group_memberships from subscribers.groups.
--
-- The companion migration (1112) created the junction table empty. This
-- migration projects every existing subscribers.groups jsonb entry into a
-- normalized membership row so the new lookup endpoints return real data on
-- day one without waiting for a re-sync.
--
-- The subscribers.groups jsonb is an array of objects shaped like
--   [{ "name": "VIP", "category": "Loyalty", "source_id": "..." }, ...]
-- (see compat.interestsToGroups). We resolve each entry to a
-- subscriber_groups definition row by name, preferring an exact (category,
-- name) match when the entry carries a category and falling back to a
-- name-only match otherwise. Entries that don't resolve to a defined group
-- are skipped — they have no group_id FK to point at.
--
-- Idempotent: ON CONFLICT DO NOTHING against the (tenant_id, subscriber_id,
-- group_id) UNIQUE means a re-run (or a partial prior run) is a no-op.
--
-- rollback-strategy: no-op — data-only, idempotent backfill; prior
-- releases never read subscriber_group_memberships, so leaving the rows in
-- place during a rollback is safe. Hard rollback = TRUNCATE
-- subscriber_group_memberships (the table itself is dropped by 1112's
-- rollback).

BEGIN;

INSERT INTO subscriber_group_memberships (tenant_id, subscriber_id, group_id)
SELECT DISTINCT s.tenant_id, s.id, g.id
  FROM subscribers s
  CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(s.groups) = 'array' THEN s.groups
           ELSE '[]'::jsonb
         END
       ) AS elem
  JOIN subscriber_groups g
    ON g.tenant_id = s.tenant_id
   AND g.name = (elem ->> 'name')
   AND (
         (elem ->> 'category') IS NULL
         OR (elem ->> 'category') = ''
         OR g.category = (elem ->> 'category')
       )
 WHERE (elem ->> 'name') IS NOT NULL
   AND (elem ->> 'name') <> ''
ON CONFLICT (tenant_id, subscriber_id, group_id) DO NOTHING;

COMMIT;
