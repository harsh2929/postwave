package jobstore

import (
	"context"
	"time"
)

// SweepExpiredSessions physically erases expired credential ciphertext and
// OAuth states. Each delete rechecks expiry under row locking, so a concurrently
// refreshed/reconnected session is retained. Every tenant uses its own RLS scope.
func (p *PostgresJobStore) SweepExpiredSessions(ctx context.Context, now time.Time, limit int) (int, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	tenants, err := p.listWorkerTenantIDs(ctx, "source retention")
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, tenant := range tenants {
		tx, err := p.beginTenant(ctx, tenant)
		if err != nil {
			return deleted, err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM migration_sessions WHERE job_id IN
		(SELECT job_id FROM migration_sessions WHERE tenant_id=$1::uuid AND expires_at<=$2 ORDER BY expires_at LIMIT $3 FOR UPDATE SKIP LOCKED)
		AND tenant_id=$1::uuid AND expires_at<=$2`, tenant, now, limit)
		if err != nil {
			_ = tx.Rollback(ctx)
			return deleted, err
		}
		_, err = tx.Exec(ctx, `DELETE FROM migration_oauth_states WHERE state IN
		(SELECT state FROM migration_oauth_states WHERE tenant_id=$1::uuid AND expires_at<=$2 ORDER BY expires_at LIMIT $3 FOR UPDATE SKIP LOCKED)
		AND tenant_id=$1::uuid AND expires_at<=$2`, tenant, now, limit)
		if err != nil {
			_ = tx.Rollback(ctx)
			return deleted, err
		}
		if err := tx.Commit(ctx); err != nil {
			return deleted, err
		}
		deleted += int(tag.RowsAffected())
	}
	return deleted, nil
}
