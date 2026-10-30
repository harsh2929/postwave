// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// sweepInboundWebhookEvents deletes authenticated inbound request snapshots
// after the tenant's webhook-delivery retention window. These rows contain the
// transformed body and troubleshooting metadata, so retaining them forever is
// both unnecessary and a material privacy liability.
func (s *Sweeper) sweepInboundWebhookEvents(ctx context.Context, tenantID string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepInboundWebhookEventsBatch(ctx, tenantID, days)
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

func (s *Sweeper) sweepInboundWebhookEventsBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM inbound_events
 WHERE ctid IN (
     SELECT ctid FROM inbound_events
      WHERE tenant_id = $1::uuid
        AND received_at < now() - ($2::int * interval '1 day')
        -- Retention must never cascade-delete accepted work that has not
        -- reached a terminal outcome. Completed/terminally-failed intents
        -- remain covered by the event's ordinary retention window.
        AND NOT EXISTS (
            SELECT 1
              FROM inbound_webhook_action_intents AS action
             WHERE action.tenant_id = inbound_events.tenant_id
               AND action.inbound_event_id = inbound_events.id
               AND action.state IN ('pending', 'leased')
        )
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete inbound_events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit inbound_events sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
