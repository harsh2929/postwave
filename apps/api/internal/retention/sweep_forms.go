// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_forms.go — hard-deletes form_submissions rows past the
// tenant's FormSubmissionRetentionDays window.
//
// Form submissions are submitted by anonymous web users (the IP +
// user_agent + custom_fields can carry significant PII) so the
// retention cutoff defaults to 365d and the column has a tight CHECK
// range in 0238_retention_policies_dataclasses.sql.
//
// We delete confirmed and unsubscribed submissions on the same
// cutoff. Pending submissions are also eligible — a pending submission
// older than the window is effectively dead anyway since the
// confirmation token will have been ignored.

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (s *Sweeper) sweepFormSubmissions(ctx context.Context, tenantID string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepFormSubmissionBatch(ctx, tenantID, days)
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

func (s *Sweeper) sweepFormSubmissionBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM form_submissions
 WHERE ctid IN (
     SELECT ctid FROM form_submissions
      WHERE tenant_id = $1::uuid
        AND submitted_at < now() - ($2::int * interval '1 day')
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete form_submissions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit form_submissions sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
