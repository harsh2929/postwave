// SPDX-License-Identifier: AGPL-3.0-only
package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// sweepDeletedInboundWebhookEndpoints purges tombstoned endpoint shells only
// after the tenant's webhook retention window and only when every retained
// event/action row is gone. Direct table DELETE is revoked from the
// application role; the guarded SECURITY DEFINER function rechecks tenant
// scope and evidence absence at the mutation boundary.
func (s *Sweeper) sweepDeletedInboundWebhookEndpoints(
	ctx context.Context,
	tenantID string,
	days int,
) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		rows, err := tx.Query(ctx, `
SELECT endpoint.id::text
  FROM inbound_webhook_endpoints AS endpoint
 WHERE endpoint.tenant_id = $1::uuid
   AND endpoint.deleted_at IS NOT NULL
   AND endpoint.deleted_at < now() - ($2::int * interval '1 day')
   AND NOT EXISTS (
       SELECT 1
         FROM inbound_events AS event
        WHERE event.tenant_id = endpoint.tenant_id
          AND event.endpoint_id = endpoint.id
   )
   AND NOT EXISTS (
       SELECT 1
         FROM inbound_webhook_action_intents AS action
        WHERE action.tenant_id = endpoint.tenant_id
          AND action.endpoint_id = endpoint.id
   )
 ORDER BY endpoint.deleted_at, endpoint.id
 FOR UPDATE SKIP LOCKED
 LIMIT $3`, tenantID, days, s.batchSize())
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("select deleted inbound webhook endpoints: %w", err)
		}
		ids := make([]string, 0, s.batchSize())
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				_ = tx.Rollback(ctx)
				return total, err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		var purged int64
		for _, id := range ids {
			var removed bool
			if err := tx.QueryRow(ctx,
				`SELECT purge_deleted_inbound_webhook_endpoint($1::uuid, $2::uuid)`,
				tenantID,
				id,
			).Scan(&removed); err != nil {
				_ = tx.Rollback(ctx)
				return total, fmt.Errorf("purge deleted inbound webhook endpoint: %w", err)
			}
			if removed {
				purged++
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf("commit inbound webhook endpoint purge: %w", err)
		}
		total += purged
		if len(ids) == 0 || purged == 0 {
			break
		}
	}
	return total, nil
}
