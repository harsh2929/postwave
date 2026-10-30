-- 1720_self_account_deletion_indexes.sql
-- Non-transactional concurrent indexes for the 1718 self-account-deletion
-- schema. Do not wrap this migration in BEGIN/COMMIT.

-- One active request per user makes DELETE /account safely retryable even
-- when a client loses the first response or omits Idempotency-Key.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS privacy_requests_active_account_user_idx
    ON privacy_requests (tenant_id, subject_user_id)
    WHERE subject_type = 'account_user'
      AND subject_user_id IS NOT NULL
      AND status IN (
          'queued', 'verifying', 'in_progress',
          'blocked_legal_hold', 'blocked_ownership'
      );

CREATE INDEX CONCURRENTLY IF NOT EXISTS privacy_requests_account_deletion_due_idx
    ON privacy_requests (execute_after, requested_at)
    WHERE request_type = 'account_deletion'
      AND subject_type = 'account_user'
      AND status IN ('queued', 'in_progress', 'blocked_legal_hold', 'blocked_ownership');
