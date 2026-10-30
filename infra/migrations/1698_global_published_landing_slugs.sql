-- 1698_global_published_landing_slugs.sql
-- Bare /landing/{slug} URLs have no tenant discriminator, so published slugs
-- must be globally unique. Keep the oldest live page and move colliding pages
-- back to draft for their owners to rename/re-publish.

BEGIN;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY lower(slug::text)
                            ORDER BY created_at, id) AS n
    FROM landing_pages
   WHERE status='published'
)
UPDATE landing_pages lp
   SET status='draft', updated_at=now()
  FROM ranked r
 WHERE lp.id=r.id AND r.n > 1;

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS landing_pages_public_slug_uniq
    ON landing_pages (lower(slug::text))
    WHERE status='published';
