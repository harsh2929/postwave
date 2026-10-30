-- Make an agent routine's optional target segment a tenant-owned canonical
-- reference at the database boundary. The original 0386 foreign key covered
-- segments(id) only, so a writer bypassing the API repository could persist a
-- segment owned by another tenant. Existing mismatches are safely detached
-- before the composite constraint is installed; the target is only a hint and
-- is already nullable with ON DELETE SET NULL semantics.
-- migration-execution: phased
-- rollback-strategy: no-op - the stricter tenant-scoped foreign key is compatible with prior application releases.

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_routines_tenant_target_segment_idx
    ON agent_routines (tenant_id, target_segment_id)
    WHERE target_segment_id IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';

UPDATE agent_routines AS routine
   SET target_segment_id = NULL
 WHERE target_segment_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1
         FROM segments AS segment
        WHERE segment.tenant_id = routine.tenant_id
          AND segment.id = routine.target_segment_id
   );

ALTER TABLE agent_routines
    DROP CONSTRAINT IF EXISTS agent_routines_target_segment_id_fkey;

ALTER TABLE agent_routines
    ADD CONSTRAINT agent_routines_tenant_target_segment_fkey
    FOREIGN KEY (tenant_id, target_segment_id)
    REFERENCES segments (tenant_id, id)
    ON DELETE SET NULL (target_segment_id);

COMMIT;
