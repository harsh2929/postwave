// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_webhooks.go — hard-deletes finalised outbound_webhook_deliveries
// rows past the tenant's WebhookDeliveryRetentionDays window. The
// outbound_webhooks.RedactionWorker already nulls the response-body
// column at 7d; this sweeper deletes the row entirely once the row
// is no longer needed for replay / debugging.
//
// We only delete rows in a terminal status (delivered | exhausted |
// skipped) so a pending or in-flight retry isn't accidentally
// removed. The created_at cutoff applies on top of the terminal
// state — both must be true for a row to be eligible.

package retention

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func (s *Sweeper) sweepOutboundWebhookDeliveries(ctx context.Context, tenantID string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepOutboundWebhookBatch(ctx, tenantID, days)
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

// sweepOutboundWebhookPlaygroundFires never deletes a simulator side-effect
// identity. It first closes overdue pending reservations as ambiguous, then
// wipes terminal inspection ciphertext under the tenant-selected lifecycle.
// The payload-free receipt_expired row permanently prevents reinsertion and
// redispatch with the same tenant/fire or tenant/idempotency identity.
func (s *Sweeper) sweepOutboundWebhookPlaygroundFires(ctx context.Context, tenantID string, days int) (int64, error) {
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		staleTag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='ambiguous', outcome='transport_ambiguous',
       receiver_status_code=0, completed_at=now()
 WHERE ctid IN (
     SELECT ctid FROM outbound_webhook_playground_fires
      WHERE tenant_id=$1::uuid
        AND state='pending'
        AND created_at <= now() - ($2::bigint * interval '1 second')
      ORDER BY created_at,fire_id
      LIMIT $3
      FOR UPDATE SKIP LOCKED
 )`, tenantID, int64(outbound_webhooks.PlaygroundPendingAmbiguityAfter/time.Second), s.batchSize())
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("close stale outbound webhook playground fires: %w", err)
		}
		var expiredRows int64
		if days > 0 {
			expiredTag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='receipt_expired', receipt_envelope=NULL,
       receipt_sha256=NULL, subject_email_sha256s='{}'::text[],
       receipt_expired_at=now()
 WHERE ctid IN (
     SELECT ctid FROM outbound_webhook_playground_fires
      WHERE tenant_id=$1::uuid
        AND state IN ('completed','ambiguous')
        AND created_at < now() - ($2::int * interval '1 day')
      ORDER BY created_at,fire_id
      LIMIT $3
      FOR UPDATE SKIP LOCKED
	 )`, tenantID, days, s.batchSize())
			if err != nil {
				_ = tx.Rollback(ctx)
				return total, fmt.Errorf("expire outbound webhook playground receipts: %w", err)
			}
			expiredRows = expiredTag.RowsAffected()
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf("commit playground fire sweep: %w", err)
		}
		n := staleTag.RowsAffected() + expiredRows
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

func (s *Sweeper) sweepOutboundWebhookBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM outbound_webhook_deliveries
 WHERE ctid IN (
     SELECT ctid FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid
        AND status IN ('delivered', 'exhausted', 'skipped')
        AND created_at < now() - ($2::int * interval '1 day')
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete outbound_webhook_deliveries: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit outbound_webhook_deliveries sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}

// sweepOutboundWebhookEventReceipts removes PII-free source-identity receipts
// only after the tenant's delivery-retention window and only when no delivery
// (including a replay child) still references that source event. Keeping the
// receipt for as long as any delivery exists preserves collision detection and
// retry idempotency; pruning orphan receipts prevents no-subscriber event
// streams from growing the ledger forever.
func (s *Sweeper) sweepOutboundWebhookEventReceipts(
	ctx context.Context,
	tenantID string,
	days int,
) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		if _, err := tx.Exec(
			ctx,
			`SELECT set_config('app.retention_worker', 'true', true)`,
		); err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("bind outbound webhook receipt retention scope: %w", err)
		}
		tag, err := tx.Exec(ctx, `
DELETE FROM outbound_webhook_event_receipts AS receipt
 WHERE receipt.ctid IN (
     SELECT candidate.ctid
       FROM outbound_webhook_event_receipts AS candidate
      WHERE candidate.tenant_id = $1::uuid
        AND candidate.occurred_at < now() - ($2::int * interval '1 day')
        AND NOT EXISTS (
            SELECT 1
              FROM outbound_webhook_deliveries AS delivery
             WHERE delivery.tenant_id = candidate.tenant_id
               AND delivery.source_event_id = candidate.source_event_id
        )
      LIMIT $3
 )`, tenantID, days, s.batchSize())
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("delete outbound_webhook_event_receipts: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf("commit outbound_webhook_event_receipts sweep: %w", err)
		}
		n := tag.RowsAffected()
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

// sweepOutboundWebhookOperatorNotifications removes only terminal lifecycle
// notifications after the same operator-visible retention window as delivery
// history. Pending/sending rows are never eligible, regardless of age.
func (s *Sweeper) sweepOutboundWebhookOperatorNotifications(
	ctx context.Context,
	tenantID string,
	days int,
) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		tag, err := tx.Exec(ctx, `
DELETE FROM outbound_webhook_operator_notifications
 WHERE ctid IN (
     SELECT ctid
       FROM outbound_webhook_operator_notifications
      WHERE tenant_id = $1::uuid
        AND status IN ('sent', 'exhausted')
        AND created_at < now() - ($2::int * interval '1 day')
      ORDER BY created_at, id
      LIMIT $3
 )`,
			tenantID, days, s.batchSize(),
		)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf(
				"delete outbound_webhook_operator_notifications: %w",
				err,
			)
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf(
				"commit outbound_webhook_operator_notifications sweep: %w",
				err,
			)
		}
		n := tag.RowsAffected()
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

// sweepDeletedOutboundWebhookEndpoints purges tombstoned endpoint secrets only
// after the configured evidence window and after every dependent delivery and
// lifecycle notification has already been retained/swept.
func (s *Sweeper) sweepDeletedOutboundWebhookEndpoints(
	ctx context.Context,
	tenantID string,
	days int,
) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		tag, err := tx.Exec(ctx, `
DELETE FROM outbound_webhooks AS webhook
 WHERE webhook.ctid IN (
     SELECT candidate.ctid
       FROM outbound_webhooks AS candidate
      WHERE candidate.tenant_id = $1::uuid
        AND candidate.deleted_at IS NOT NULL
        AND candidate.deleted_at < now() - ($2::int * interval '1 day')
        AND NOT EXISTS (
            SELECT 1
              FROM outbound_webhook_deliveries AS delivery
             WHERE delivery.tenant_id = candidate.tenant_id
               AND delivery.webhook_id = candidate.id
        )
        AND NOT EXISTS (
            SELECT 1
              FROM outbound_webhook_operator_notifications AS notification
             WHERE notification.tenant_id = candidate.tenant_id
               AND notification.webhook_id = candidate.id
        )
      ORDER BY candidate.deleted_at, candidate.id
      LIMIT $3
 )`,
			tenantID, days, s.batchSize(),
		)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("delete tombstoned outbound_webhooks: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf("commit tombstoned outbound_webhooks sweep: %w", err)
		}
		n := tag.RowsAffected()
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}
