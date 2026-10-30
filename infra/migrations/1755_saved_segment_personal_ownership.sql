-- Preserve the ownership boundary introduced by saved-segment personal scope.
-- Historical rows predate created_by_user_id and were intentionally shared by
-- the legacy API, so make that sharing explicit before actor-aware reads begin.
-- Personal rows that lose their owner after this migration remain personal and
-- invisible; they must never be promoted to workspace scope implicitly.
-- rollback-strategy: expand-contract
-- rollback-details: leave applied; older servers already treated historical
-- unattributed rows as workspace-visible.

BEGIN;

UPDATE saved_segments
   SET visibility_scope = 'workspace'
 WHERE visibility_scope = 'personal'
   AND created_by_user_id IS NULL;

COMMIT;
