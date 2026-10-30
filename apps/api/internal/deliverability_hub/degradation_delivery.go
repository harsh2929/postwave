// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	degradationDeliveryBatchSize  = 100
	degradationDeliveryLease      = 2 * time.Minute
	degradationDeliveryMaxBackoff = time.Hour
)

type leasedDegradationNotification struct {
	TenantID       string
	ModelVersion   string
	FromSnapshotID int64
	ToSnapshotID   int64
	PreviousScore  int
	CurrentScore   int
	CurrentGrade   string
	TopBreachCode  string
	TopBreachTitle string
	BreachCount    int
	LeaseToken     string
	AttemptCount   int
}

func (item leasedDegradationNotification) alert() HealthAlert {
	return HealthAlert{
		TenantID:       item.TenantID,
		IncidentID:     fmt.Sprintf("snapshot:%d", item.ToSnapshotID),
		Score:          item.CurrentScore,
		PreviousScore:  item.PreviousScore,
		Grade:          item.CurrentGrade,
		TopBreachCode:  item.TopBreachCode,
		TopBreachTitle: item.TopBreachTitle,
		BreachCount:    item.BreachCount,
	}
}

// deliverPendingDegradationNotifications drains one bounded batch. Claim rows
// are the durable outbox; a lease prevents concurrent replicas from invoking
// the notifier together. If a process dies after dispatch but before the ACK,
// the lease expires and the stable IncidentID makes the notifier retry dedupe
// against the already-created notification-feed identity.
func (w *Worker) deliverPendingDegradationNotifications(ctx context.Context) error {
	items, err := w.leaseDegradationNotifications(ctx, degradationDeliveryBatchSize)
	if err != nil {
		return fmt.Errorf("deliverability degradation notifications: lease: %w", err)
	}
	var deliveryErrs []error
	for _, item := range items {
		deliveryErr := w.notifyDegraded(ctx, item.alert())
		if deliveryErr == nil {
			if err := w.finishDegradationNotification(ctx, item, nil); err != nil {
				deliveryErrs = append(deliveryErrs, err)
			}
			continue
		}
		if err := w.finishDegradationNotification(ctx, item, deliveryErr); err != nil {
			deliveryErrs = append(deliveryErrs, errors.Join(deliveryErr, err))
			continue
		}
		deliveryErrs = append(deliveryErrs, fmt.Errorf(
			"incident %s/%s/%d: %w",
			item.TenantID,
			item.ModelVersion,
			item.FromSnapshotID,
			deliveryErr,
		))
	}
	return errors.Join(deliveryErrs...)
}

func (w *Worker) leaseDegradationNotifications(
	ctx context.Context,
	limit int,
) ([]leasedDegradationNotification, error) {
	if w == nil || w.Deps == nil || w.Deps.Pool == nil {
		return nil, errors.New("nil dependencies")
	}
	if limit <= 0 {
		return nil, nil
	}
	tx, err := db.WithWorkerScope(ctx, w.Deps.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH due AS (
    SELECT tenant_id, model_version, from_snapshot_id
      FROM deliverability_degradation_claims
     WHERE operator_notified_at IS NULL
       AND operator_next_attempt_at <= now()
       AND (operator_lease_expires_at IS NULL OR operator_lease_expires_at <= now())
     ORDER BY operator_next_attempt_at ASC, claimed_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $1
), leased AS (
    UPDATE deliverability_degradation_claims AS claim
       SET operator_lease_token = gen_random_uuid(),
           operator_lease_expires_at = now() + ($2 * INTERVAL '1 second'),
           operator_attempt_count = claim.operator_attempt_count + 1,
           operator_last_error = NULL
      FROM due
     WHERE claim.tenant_id = due.tenant_id
       AND claim.model_version = due.model_version
       AND claim.from_snapshot_id = due.from_snapshot_id
    RETURNING claim.tenant_id::text,
              claim.model_version,
              claim.from_snapshot_id,
              claim.to_snapshot_id,
              claim.previous_score,
              claim.current_score,
              claim.current_grade,
              claim.top_breach_code,
              claim.top_breach_title,
              claim.breach_count,
              claim.operator_lease_token::text,
              claim.operator_attempt_count
)
SELECT * FROM leased`, limit, int64(degradationDeliveryLease/time.Second))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]leasedDegradationNotification, 0)
	for rows.Next() {
		var item leasedDegradationNotification
		if err := rows.Scan(
			&item.TenantID,
			&item.ModelVersion,
			&item.FromSnapshotID,
			&item.ToSnapshotID,
			&item.PreviousScore,
			&item.CurrentScore,
			&item.CurrentGrade,
			&item.TopBreachCode,
			&item.TopBreachTitle,
			&item.BreachCount,
			&item.LeaseToken,
			&item.AttemptCount,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return items, nil
}

func (w *Worker) finishDegradationNotification(
	ctx context.Context,
	item leasedDegradationNotification,
	deliveryErr error,
) error {
	tx, err := db.WithWorkerScope(ctx, w.Deps.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tag pgconn.CommandTag
	if deliveryErr == nil {
		tag, err = tx.Exec(ctx, `
UPDATE deliverability_degradation_claims
   SET operator_notified_at = now(),
       operator_next_attempt_at = NULL,
       operator_lease_token = NULL,
       operator_lease_expires_at = NULL,
       operator_last_error = NULL
 WHERE tenant_id = $1::uuid
   AND model_version = $2
   AND from_snapshot_id = $3
   AND operator_lease_token = $4::uuid
   AND operator_notified_at IS NULL`,
			item.TenantID,
			item.ModelVersion,
			item.FromSnapshotID,
			item.LeaseToken,
		)
	} else {
		retryAt := w.Deps.now().UTC().Add(degradationDeliveryBackoff(item.AttemptCount))
		message := strings.TrimSpace(deliveryErr.Error())
		if len(message) > 1024 {
			message = message[:1024]
		}
		tag, err = tx.Exec(ctx, `
UPDATE deliverability_degradation_claims
   SET operator_next_attempt_at = $5,
       operator_lease_token = NULL,
       operator_lease_expires_at = NULL,
       operator_last_error = $6
 WHERE tenant_id = $1::uuid
   AND model_version = $2
   AND from_snapshot_id = $3
   AND operator_lease_token = $4::uuid
   AND operator_notified_at IS NULL`,
			item.TenantID,
			item.ModelVersion,
			item.FromSnapshotID,
			item.LeaseToken,
			retryAt,
			message,
		)
	}
	if err != nil {
		return fmt.Errorf("finish incident %s/%s/%d: %w",
			item.TenantID, item.ModelVersion, item.FromSnapshotID, err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf(
			"finish incident %s/%s/%d affected %d rows, want 1",
			item.TenantID,
			item.ModelVersion,
			item.FromSnapshotID,
			tag.RowsAffected(),
		)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func degradationDeliveryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 6 {
		shift = 6
	}
	delay := time.Minute * time.Duration(1<<shift)
	if delay > degradationDeliveryMaxBackoff {
		return degradationDeliveryMaxBackoff
	}
	return delay
}
