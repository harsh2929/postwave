-- 1780_global_published_form_slugs.sql
--
-- Bare /forms/{slug} URLs have no tenant discriminator, so two tenants must
-- never have published forms with the same case-insensitive slug. Keep the
-- oldest live form as the canonical public destination and move later
-- collisions back to draft so their owners can choose a new hosted URL.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction. Keep the repair
-- and index in the same restartable non-transactional phase so any failed
-- build or concurrent publication causes a retry to rerun the idempotent
-- repair before attempting the uniqueness guard again.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Keep the global uniqueness guard during application rollback. Restoring ambiguous published slugs would make a tenant-less public URL resolve to an arbitrary workspace; affected owners must rename and explicitly re-publish their drafts.

WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY lower(slug::text)
               ORDER BY created_at, id
           ) AS publication_rank
      FROM forms
     WHERE status = 'published'
)
UPDATE forms AS f
   SET status = 'draft',
       updated_at = now()
  FROM ranked AS r
 WHERE f.id = r.id
   AND r.publication_rank > 1;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS forms_public_slug_uniq
    ON forms (lower(slug::text))
    WHERE status = 'published';
