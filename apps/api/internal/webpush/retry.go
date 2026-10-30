// SPDX-License-Identifier: AGPL-3.0-only
package webpush

import (
	"context"
	"encoding/json"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The half of the delivery ledger that actually recovers a notification.
//
// Migration 1883 made a failed web push visible and said a retry worker was
// "separate work". Separate work that never arrives is the failure this
// codebase keeps recording: a table of failures nobody acts on is a more
// detailed way of losing the notification. This is that worker.
//
// It reconstructs the payload from the FEED ROW rather than from a copy stored
// beside the delivery. `entity_id` already holds the notification id, and
// `notification_feed` already holds the title, body and deep link — duplicating
// customer-facing text into a second table would duplicate a deletion
// obligation along with it.

// maxSendAttempts bounds how many times one notification is offered to a push
// service before the row goes terminal.
//
// Six, with the doubling backoff in `recordAttempt`, spans roughly an hour —
// past any ordinary rate limit and short of the 24h TTL the push itself
// carries. A notification still undelivered after that is not going to be
// rescued by a seventh attempt, and continuing to retry hides a broken
// subscription behind an ever-growing attempt count.
const maxSendAttempts = 6

// RetryDue re-sends deliveries whose backoff has elapsed, and retires the ones
// that have run out of attempts.
//
// Returns how many were re-sent and how many were retired. Errors from an
// individual send are recorded on that row, not returned: one dead endpoint
// must not stop the sweep, which is the same reason `SendToUser` continues past
// a failed subscription.
func (d *Deps) RetryDue(ctx context.Context, now time.Time, limit int) (retried, retired int, err error) {
	if d == nil || d.Pool == nil || !d.Enabled() {
		return 0, 0, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	retired, err = d.retireExhausted(ctx, now)
	if err != nil {
		return 0, 0, err
	}
	due, err := d.claimDue(ctx, now, limit)
	if err != nil {
		return 0, retired, err
	}
	for _, item := range due {
		resp, sendErr := d.deliver(ctx, storedSubscription{
			Endpoint: item.Endpoint, P256dh: item.P256dh, Auth: item.Auth,
		}, item.Payload)
		if sendErr != nil {
			d.record(ctx, item.TenantID, item.UserID, item.Endpoint, item.Notification, statusFailed, "transport_error")
			continue
		}
		status := resp.StatusCode
		_ = resp.Body.Close()
		switch {
		case status == 404 || status == 410:
			d.record(ctx, item.TenantID, item.UserID, item.Endpoint, item.Notification, statusExpired, "Gone")
			_ = d.deleteSubscription(ctx, item.TenantID, item.UserID, item.Endpoint)
		case status >= 200 && status < 300:
			d.record(ctx, item.TenantID, item.UserID, item.Endpoint, item.Notification, statusSent, "")
			retried++
		default:
			d.record(ctx, item.TenantID, item.UserID, item.Endpoint, item.Notification, statusFailed, "retry_rejected")
		}
	}
	return retried, retired, nil
}

// retireExhausted marks rows that have used their attempts as terminal.
//
// Run BEFORE the claim, so an exhausted row cannot be claimed and attempted a
// seventh time in the same sweep.
func (d *Deps) retireExhausted(ctx context.Context, now time.Time) (int, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE web_push_deliveries
   SET terminal_at   = $1,
       next_retry_at = NULL,
       error_code    = CASE WHEN error_code = '' THEN 'attempts_exhausted' ELSE error_code END,
       updated_at    = now()
 WHERE terminal_at IS NULL AND status = 'failed' AND attempts >= $2`, now, maxSendAttempts)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

type dueDelivery struct {
	TenantID, UserID, Endpoint string
	P256dh, Auth               string
	Notification               Notification
	Payload                    []byte
}

// claimDue takes eligible rows and rebuilds each notification from its feed row.
//
// FOR UPDATE SKIP LOCKED so two workers do not both re-send one notification,
// and `next_retry_at` is pushed out as part of the claim so a crash mid-sweep
// delays the row rather than releasing it into a tight loop.
func (d *Deps) claimDue(ctx context.Context, now time.Time, limit int) ([]dueDelivery, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT wd.id
      FROM web_push_deliveries wd
     WHERE wd.terminal_at IS NULL
       AND wd.status = 'failed'
       AND wd.attempts < $2
       AND wd.next_retry_at IS NOT NULL
       AND wd.next_retry_at <= $1
     ORDER BY wd.next_retry_at
     FOR UPDATE OF wd SKIP LOCKED
     LIMIT $3
), claimed AS (
    UPDATE web_push_deliveries wd
       SET next_retry_at = $1 + interval '5 minutes', updated_at = now()
      FROM candidates c
     WHERE wd.id = c.id
 RETURNING wd.tenant_id, wd.user_id, wd.endpoint, wd.entity_id, wd.event_type
)
SELECT c.tenant_id::text, c.user_id::text, c.endpoint,
       COALESCE(nf.title, ''), COALESCE(nf.body, ''), COALESCE(nf.deep_link, ''),
       c.entity_id, c.event_type,
       s.p256dh, s.auth
  FROM claimed c
  JOIN web_push_subscriptions s
    ON s.tenant_id = c.tenant_id AND s.user_id = c.user_id AND s.endpoint = c.endpoint
  LEFT JOIN notification_feed nf
    ON nf.tenant_id = c.tenant_id AND nf.id::text = c.entity_id`, now, maxSendAttempts, limit)
	if err != nil {
		return nil, err
	}
	var out []dueDelivery
	for rows.Next() {
		var item dueDelivery
		var title, body, deepLink, entityID, eventType string
		if err := rows.Scan(&item.TenantID, &item.UserID, &item.Endpoint,
			&title, &body, &deepLink, &entityID, &eventType,
			&item.P256dh, &item.Auth); err != nil {
			rows.Close()
			return nil, err
		}
		if title == "" {
			// The feed row is gone — trimmed by retention, or the notification
			// was deleted. There is nothing to re-send, and inventing a title
			// would deliver a notification whose content the person is no
			// longer entitled to see.
			continue
		}
		item.Notification = Notification{
			Title: title, Body: body, URL: deepLink,
			NotificationID: entityID, Event: eventType,
		}
		payload, err := marshalNotification(item.Notification)
		if err != nil {
			continue
		}
		item.Payload = payload
		out = append(out, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// marshalNotification is the one place a Notification becomes wire bytes.
//
// Extracted so the retry path cannot drift from SendToUser's encoding — two
// json.Marshal calls with the same struct agree today and would not survive one
// of them gaining a field.
func marshalNotification(n Notification) ([]byte, error) {
	return json.Marshal(n)
}
