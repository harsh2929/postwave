-- 0278_audit_merkle_tree_size.sql
--
-- Inclusion / consistency-proof API for audit_merkle_roots.
--
-- The customer-callable proof endpoints (GET /api/v1/audit/{id}/inclusion-proof,
-- GET /api/v1/audit/consistency-proof) need two extra columns on
-- audit_merkle_roots to express checkpoints in RFC 9162 terms:
--
--   tree_size           — number of audit_log rows committed to this root
--                          (== count of (tenant_id, id <= upto_audit_id) at
--                          the moment we rooted). Used as the "tree_size"
--                          field in the inclusion proof JSON and as the
--                          range argument for consistency proofs.
--
--   prev_checkpoint_id  — id of the previous root in this tenant's chain,
--                          so a verifier walking from old_size → new_size
--                          can iterate checkpoints without re-querying
--                          windows of rooted_at timestamps.
--
-- Both default sensibly so the worker keeps inserting after the migration
-- without needing a code change in the same deploy. The Go MerkleWorker
-- starts populating them on the next tick; existing rows ride with 0 /
-- NULL until the next root snapshot rewrites them.

BEGIN;

ALTER TABLE audit_merkle_roots
    ADD COLUMN IF NOT EXISTS tree_size           bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS prev_checkpoint_id  bigint REFERENCES audit_merkle_roots(id) ON DELETE SET NULL;

-- Backfill tree_size for any existing roots using the COUNT(*) of
-- audit_log rows up to each root's upto_audit_id within the same tenant.
-- Safe to run repeatedly — only touches rows where tree_size is still 0.
-- For typical fresh installs this updates 0 rows.
UPDATE audit_merkle_roots r
   SET tree_size = sub.cnt
  FROM (
    SELECT r2.id AS id,
           (SELECT COUNT(*) FROM audit_log al
             WHERE al.tenant_id = r2.tenant_id
               AND al.id <= r2.upto_audit_id) AS cnt
      FROM audit_merkle_roots r2
     WHERE r2.tree_size = 0
  ) sub
 WHERE r.id = sub.id;

-- Range queries by tree_size — supports consistency proofs that pick
-- the smallest root with tree_size >= target.
CREATE INDEX IF NOT EXISTS idx_audit_merkle_roots_tenant_tree_size
    ON audit_merkle_roots (tenant_id, tree_size);

-- The `tenant_visible` policy from 0123 already covers SELECT for the
-- new columns (column adds inherit the table-level RLS policies). No
-- new policies needed here; the inclusion-proof handler reads via a
-- tenant-bound tx (set_config('app.tenant_id', $1, false)) and reads
-- the same row set as the existing audit endpoints.

COMMIT;
