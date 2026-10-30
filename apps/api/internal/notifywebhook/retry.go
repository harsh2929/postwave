// SPDX-License-Identifier: AGPL-3.0-only
package notifywebhook

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

// The sweep for the one notification channel that had no retry at all.
//
// Chat runs through the outbox and is retried there. Web push got its own sweep
// in migration 1886. This channel had neither: `Fanout.Dispatch` returns
// `[]Delivery` and no error, so a failed post is logged, cannot propagate to
// whatever queued the dispatch, and nothing tries again.
//
// The message is rebuilt from the FEED ROW and the destination from the user's
// PREFERENCES — neither is copied onto the delivery record. Copying the URL
// would retry a Slack address the person has since corrected; copying the text
// would duplicate a deletion obligation.

// PostSender is the send side, satisfied by *Poster.
//
// Named PostSender rather than Poster because `Poster` is already the concrete
// SSRF-safe struct in this package — a collision the compiler caught, and the
// kind of shadowing that otherwise produces a confusing pair of names.
type PostSender interface {
	Post(ctx context.Context, url, kind, text, eventType string) error
}

// RetryDue re-posts failed deliveries whose backoff has elapsed.
//
// Rows past MaxPostAttempts are retired by the recorder itself, which stops
// scheduling them — there is no separate retirement pass, because the attempt
// that exhausts the budget is the one that knows it did.
func (r *Recorder) RetryDue(ctx context.Context, p PostSender, now time.Time, limit int) (retried, failed int, err error) {
	if r == nil || r.Pool == nil || p == nil {
		return 0, 0, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	due, err := r.claimDue(ctx, now, limit)
	if err != nil {
		return 0, 0, err
	}
	for _, item := range due {
		postErr := p.Post(ctx, item.URL, item.Kind, item.Text, item.EventType)
		// Recorded through the same path the original post used, so a retry
		// updates attempts, status and the schedule by exactly the rules that
		// produced the row.
		if err := r.Record(ctx, item.TenantID, item.UserID, item.NotificationID,
			item.EventType, item.Kind, postErr); err != nil {
			return retried, failed, err
		}
		if postErr != nil {
			failed++
			continue
		}
		retried++
	}
	return retried, failed, nil
}

type dueWebhook struct {
	TenantID, UserID, NotificationID string
	EventType, Kind, URL, Text       string
}

// claimDue takes eligible rows and rebuilds each message and destination.
//
// FOR UPDATE SKIP LOCKED so two workers do not re-post one notification, and
// the claim pushes `next_retry_at` out so a crash mid-sweep delays the row
// instead of releasing it into a tight loop.
func (r *Recorder) claimDue(ctx context.Context, now time.Time, limit int) ([]dueWebhook, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT d.id
      FROM notification_webhook_deliveries d
     WHERE d.status = 'failed'
       AND d.next_retry_at IS NOT NULL
       AND d.next_retry_at <= $1
       AND d.attempts < $2
     ORDER BY d.next_retry_at
     FOR UPDATE OF d SKIP LOCKED
     LIMIT $3
), claimed AS (
    UPDATE notification_webhook_deliveries d
       SET next_retry_at = $1 + interval '5 minutes', updated_at = now()
      FROM candidates c
     WHERE d.id = c.id
 RETURNING d.tenant_id, d.user_id, d.notification_id, d.event_type, d.kind
)
SELECT c.tenant_id::text, c.user_id::text, c.notification_id::text,
       c.event_type,
       COALESCE(NULLIF(np.notification_webhook_kind, ''), c.kind, 'slack'),
       COALESCE(np.notification_webhook_url, ''),
       COALESCE(nf.title, ''), COALESCE(nf.body, ''), COALESCE(nf.deep_link, '')
  FROM claimed c
  JOIN notification_preferences np
    ON np.tenant_id = c.tenant_id AND np.user_id = c.user_id
  LEFT JOIN notification_feed nf
    ON nf.tenant_id = c.tenant_id AND nf.id = c.notification_id`, now, MaxPostAttempts, limit)
	if err != nil {
		return nil, err
	}
	var out []dueWebhook
	for rows.Next() {
		var item dueWebhook
		var title, body, deepLink string
		if err := rows.Scan(&item.TenantID, &item.UserID, &item.NotificationID,
			&item.EventType, &item.Kind, &item.URL, &title, &body, &deepLink); err != nil {
			rows.Close()
			return nil, err
		}
		// No destination any more — the person removed or changed their webhook
		// URL. Retrying to nowhere is pointless and retrying to a REPLACED
		// address would be worse, so the row is simply not claimed further.
		if item.URL == "" {
			continue
		}
		// No feed row: trimmed by retention or deleted. Nothing to say, and
		// inventing a message would deliver content the person may no longer be
		// entitled to see.
		if title == "" {
			continue
		}
		// The one fidelity gap, stated rather than hidden: the original post
		// used `Event.MobileBody` when set, which is not persisted anywhere.
		// The feed row's body is the canonical text and the closest available,
		// so a retried message can be longer than the one it replaces.
		item.Text = notifyfanout.WebhookText(title, body, deepLink)
		out = append(out, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
