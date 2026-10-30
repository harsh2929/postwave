-- 1831_campaign_template_design_refinement_receipts.sql
--
-- Bind every completed refinement revision to the normalized refinement
-- request that produced it. The mutation-key ledger proves that a caller
-- replayed the same request, but registration intentionally happens before
-- the queue transition. Without a durable result receipt, another tab could
-- win the queue race and a later replay could mistake that unrelated revision
-- for the registered request merely because both started from the same base.
--
-- Existing revisions remain NULL and therefore fail closed on ambiguous
-- replay. New workers persist the request hash in the same transaction as the
-- immutable revision output.
--
-- rollback-strategy: no-op
-- rollback-details: the nullable receipt is additive operational evidence.
-- Older binaries ignore it safely; retain it across an application rollback.

BEGIN;

ALTER TABLE campaign_template_design_revisions
    ADD COLUMN refinement_request_hash bytea
        CHECK (
            refinement_request_hash IS NULL
            OR octet_length(refinement_request_hash) = 32
        );

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_template_design_refinement_receipt_idx
    ON campaign_template_design_revisions (
        tenant_id,
        draft_id,
        base_revision,
        refinement_request_hash
    )
    WHERE operation = 'refine'
      AND refinement_request_hash IS NOT NULL;

BEGIN;

COMMENT ON COLUMN campaign_template_design_revisions.refinement_request_hash IS
    'SHA-256 of the normalized refinement payload that produced this immutable revision; NULL for initial/repair and pre-1831 history.';

COMMIT;
