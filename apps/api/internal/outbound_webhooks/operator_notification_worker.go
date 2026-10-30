// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultOperatorNotificationBatch         = 20
	defaultOperatorNotificationPollInterval  = 15 * time.Second
	defaultOperatorNotificationLeaseDuration = 2 * time.Minute
	maxOperatorNotificationAttempts          = 12
)

var operatorNotificationBackoff = []time.Duration{
	time.Minute,
	5 * time.Minute,
	30 * time.Minute,
	2 * time.Hour,
	8 * time.Hour,
	24 * time.Hour,
}

var (
	outboundWebhookOperatorNotificationSentTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "outbound_webhook_operator_notification_sent_total",
		Help: "Durable outbound webhook lifecycle notifications successfully handled.",
	})
	outboundWebhookOperatorNotificationExhaustedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "outbound_webhook_operator_notification_exhausted_total",
		Help: "Durable outbound webhook lifecycle notifications that exhausted retries.",
	})
)

type pendingOperatorNotification struct {
	ID        string
	TenantID  string
	WebhookID string
	Kind      string
	Attempts  int
}

// AutoDisableNotificationWorker drains the lifecycle-notification outbox.
// Claims are leased with SKIP LOCKED, so multiple API replicas can run it.
type AutoDisableNotificationWorker struct {
	Pool          *db.Pool
	Notifier      AutoDisableNotifier
	Logger        *slog.Logger
	Owner         string
	BatchSize     int
	PollInterval  time.Duration
	LeaseDuration time.Duration
}

func (w *AutoDisableNotificationWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return nil
	}
	if w.Notifier == nil {
		return errors.New("outbound_webhooks: auto-disable notifier is not configured")
	}
	interval := w.PollInterval
	if interval <= 0 {
		interval = defaultOperatorNotificationPollInterval
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			count, err := w.runOnce(ctx)
			if err != nil {
				w.logger().Warn("outbound_webhooks: notification outbox tick failed", "err", err.Error())
			}
			next := interval
			if count > 0 {
				next = 50 * time.Millisecond
			}
			timer.Reset(next)
		}
	}
}

func (w *AutoDisableNotificationWorker) runOnce(ctx context.Context) (int, error) {
	owner := strings.TrimSpace(w.Owner)
	if owner == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "unknown-host"
		}
		owner = fmt.Sprintf("%s-%d-notifications", host, os.Getpid())
	}
	batch := w.BatchSize
	if batch <= 0 || batch > 100 {
		batch = defaultOperatorNotificationBatch
	}
	lease := w.LeaseDuration
	if lease <= 0 {
		lease = defaultOperatorNotificationLeaseDuration
	}
	pending, err := w.claim(ctx, owner, batch, lease)
	if err != nil {
		return 0, err
	}
	for _, notification := range pending {
		if ctx.Err() != nil {
			w.release(notification.ID, owner)
			continue
		}
		err := w.Notifier.NotifyWebhookAutoDisabled(
			ctx,
			notification.TenantID,
			notification.WebhookID,
		)
		if err == nil {
			if markErr := w.markSent(ctx, notification.ID, owner); markErr != nil {
				w.logger().Warn(
					"outbound_webhooks: mark operator notification sent failed",
					"notification", notification.ID,
					"err", markErr.Error(),
				)
			} else {
				outboundWebhookOperatorNotificationSentTotal.Inc()
			}
			continue
		}
		exhausted, markErr := w.markFailed(
			ctx,
			notification.ID,
			owner,
			notification.Attempts,
			err,
		)
		if markErr != nil {
			w.logger().Warn(
				"outbound_webhooks: reschedule operator notification failed",
				"notification", notification.ID,
				"err", markErr.Error(),
			)
			continue
		}
		if exhausted {
			outboundWebhookOperatorNotificationExhaustedTotal.Inc()
			w.logger().Error(
				"outbound_webhooks: operator notification exhausted",
				"notification", notification.ID,
				"tenant", notification.TenantID,
				"webhook", notification.WebhookID,
			)
		}
	}
	return len(pending), nil
}

func (w *AutoDisableNotificationWorker) claim(
	ctx context.Context,
	owner string,
	limit int,
	lease time.Duration,
) ([]pendingOperatorNotification, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	leaseInterval := fmt.Sprintf("%d microseconds", lease.Microseconds())
	rows, err := tx.Query(ctx, `
WITH picked AS (
    SELECT id
      FROM outbound_webhook_operator_notifications
     WHERE (
               status = 'pending'
               OR (
                   status = 'sending'
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at <= now()
               )
           )
       AND COALESCE(next_attempt_at, created_at) <= now()
       AND EXISTS (
           SELECT 1
             FROM outbound_webhooks AS webhook
            WHERE webhook.id = outbound_webhook_operator_notifications.webhook_id
              AND webhook.tenant_id = outbound_webhook_operator_notifications.tenant_id
              AND webhook.deleted_at IS NULL
       )
     ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $1
)
UPDATE outbound_webhook_operator_notifications AS notification
   SET status = 'sending',
       attempts = notification.attempts + 1,
       lease_owner = $2,
       lease_expires_at = now() + $3::interval
  FROM picked
 WHERE notification.id = picked.id
RETURNING notification.id::text, notification.tenant_id::text,
          notification.webhook_id::text, notification.kind,
          notification.attempts`,
		limit, owner, leaseInterval,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]pendingOperatorNotification, 0, limit)
	for rows.Next() {
		var notification pendingOperatorNotification
		if err := rows.Scan(
			&notification.ID,
			&notification.TenantID,
			&notification.WebhookID,
			&notification.Kind,
			&notification.Attempts,
		); err != nil {
			return nil, err
		}
		if notification.Kind != "auto_disabled" {
			return nil, fmt.Errorf(
				"outbound_webhooks: unsupported operator notification kind %q",
				notification.Kind,
			)
		}
		out = append(out, notification)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (w *AutoDisableNotificationWorker) markSent(ctx context.Context, id, owner string) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_operator_notifications
   SET status = 'sent',
       sent_at = now(),
       next_attempt_at = NULL,
       last_error = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE id::text = $1
   AND status = 'sending'
   AND lease_owner = $2`,
		id, owner,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

func (w *AutoDisableNotificationWorker) markFailed(
	ctx context.Context,
	id,
	owner string,
	attempts int,
	notifyErr error,
) (bool, error) {
	exhausted := attempts >= maxOperatorNotificationAttempts
	status := "pending"
	var nextAttempt any
	if exhausted {
		status = "exhausted"
	} else {
		backoffIndex := attempts - 1
		if backoffIndex < 0 {
			backoffIndex = 0
		}
		if backoffIndex >= len(operatorNotificationBackoff) {
			backoffIndex = len(operatorNotificationBackoff) - 1
		}
		nextAttempt = time.Now().UTC().Add(operatorNotificationBackoff[backoffIndex])
	}
	message := "notification delivery failed"
	if notifyErr != nil {
		message, _ = redactInspectablePlaygroundText(notifyErr.Error(), nil)
		message = truncate(message, 512)
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_operator_notifications
   SET status = $3,
       next_attempt_at = $4,
       last_error = $5,
       exhausted_at = CASE WHEN $3 = 'exhausted' THEN now() ELSE NULL END,
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE id::text = $1
   AND status = 'sending'
   AND lease_owner = $2`,
		id, owner, status, nextAttempt, message,
	)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() != 1 {
		return false, ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return exhausted, nil
}

func (w *AutoDisableNotificationWorker) release(id, owner string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `
UPDATE outbound_webhook_operator_notifications
   SET status = 'pending',
       next_attempt_at = now(),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE id::text = $1
   AND status = 'sending'
   AND lease_owner = $2`,
		id, owner,
	)
	_ = tx.Commit(ctx)
}

func (w *AutoDisableNotificationWorker) logger() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}
