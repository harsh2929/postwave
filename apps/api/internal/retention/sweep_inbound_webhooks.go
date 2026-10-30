// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_inbound_webhooks.go — hard-deletes inbound webhook_deliveries
// rows past the tenant's WebhookDeliveryRetentionDays window. Reuses
// the same retention dimension as outbound deliveries (they're the
// same operational concept: "how long do we keep webhook firing /
// receipt logs?"), so operators get one knob to tune instead of two
// with overlapping semantics.
//
// Schema note: the inbound webhook_deliveries table (migration 0017)
// is shaped for receipt logging — `at timestamptz` instead of the
// outbound table's `created_at`, no terminal status column. The
// batched DELETE bounds by `at < cutoff` only; no status filter
// since "delivered" is implicit for any row that landed in the table.

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (s *Sweeper) sweepInboundWebhookDeliveries(ctx context.Context, tenantID string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepInboundWebhookBatch(ctx, tenantID, days)
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

func (s *Sweeper) sweepInboundWebhookBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Present the retention capability. webhook_deliveries admits a DELETE only
	// from a transaction that sets this, so a tenant cannot erase its own
	// delivery evidence while the scheduled purge still can. Without it this
	// statement raised "permission denied for table webhook_deliveries".
	if _, err := tx.Exec(ctx, `SELECT set_config('app.retention_worker', 'true', true)`); err != nil {
		return 0, fmt.Errorf("webhook_deliveries retention scope: %w", err)
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM webhook_deliveries
 WHERE ctid IN (
     SELECT ctid FROM webhook_deliveries
      WHERE tenant_id = $1::uuid
        AND at < now() - ($2::int * interval '1 day')
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete webhook_deliveries: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit webhook_deliveries sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
