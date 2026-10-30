// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_unsubscribed.go — hard-deletes subscriber rows that have been
// in a "disabled" or "blocklisted" status longer than the tenant's
// UnsubscribedSubscriberRetentionDays window.
//
// Why not a soft delete: the subscribers row IS the PII. Keeping it
// around with an "anonymised" flag still tags the email address as
// "they unsubscribed from us" which is exactly the linkage we want
// to break once the retention window elapses.
//
// We key the cutoff off subscribers.updated_at because the
// schema (0003_subscribers.sql) doesn't carry a dedicated
// unsubscribed_at column and updated_at fires from the
// set_updated_at trigger on the status flip. This means a tenant
// who later re-confirms a subscriber will refresh updated_at and
// reset the retention clock, which is the desired behaviour.

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (s *Sweeper) sweepUnsubscribedSubscribers(ctx context.Context, tenantID string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepUnsubscribedBatch(ctx, tenantID, days)
		if err != nil {
			return total, err
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

func (s *Sweeper) sweepUnsubscribedBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Use ctid to bound the per-batch row count — LIMIT is not legal
	// on a DELETE in Postgres directly.
	tag, err := tx.Exec(ctx, `
DELETE FROM subscribers
 WHERE ctid IN (
     SELECT ctid FROM subscribers
      WHERE tenant_id = $1::uuid
        AND status IN ('disabled', 'blocklisted')
        AND updated_at < now() - ($2::int * interval '1 day')
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete unsubscribed subscribers: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit unsubscribed sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
