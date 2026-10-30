// SPDX-License-Identifier: AGPL-3.0-only
package notifywebhook

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Recorder writes what happened to a notification webhook post.
//
// It lives here rather than in `notifyfanout` for the same reason the Poster
// does: this package may import the db layer and that one may not, by design —
// every collaborator there is an interface so a test can fake exactly one
// channel.
//
// This was the last of the four notifyfanout channels with no durable record.
// The feed row is the identity; web push got migration 1883; the chat
// integrations got 1884; and this one logged its failures and stored nothing.
// Somebody who configured a Slack destination so they would hear about
// approvals heard nothing when it broke, and no query could tell them it had
// been attempted.
// MaxPostAttempts bounds how many times one notification is offered to a
// destination before its row is retired.
//
// Six, matching web push: with the doubling backoff that spans about an hour,
// past any ordinary outage. Continuing past it would hide a permanently broken
// Slack URL behind a growing attempt count instead of surfacing it.
const MaxPostAttempts = 6

type Recorder struct{ Pool *db.Pool }

// NewRecorder builds a recorder over the tenant-scoped pool.
func NewRecorder(pool *db.Pool) *Recorder { return &Recorder{Pool: pool} }

// Record implements notifyfanout.WebhookRecorder.
//
// Upserts on (tenant, notification, user): one feed row is one logical
// notification for one person, so there is at most one attempt record per pair
// and a retry updates it in place with an incremented count. That is the same
// guarantee an idempotency key would give, expressed in the identity the
// channel already has — and this channel needs no key of its own, because it is
// unreachable from outside the fanout and the fanout only reaches it when the
// feed row was newly created.
func (r *Recorder) Record(ctx context.Context, tenantID, userID, notificationID, eventType, kind string, postErr error) error {
	if r == nil || r.Pool == nil {
		return nil
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(userID) == "" ||
		strings.TrimSpace(notificationID) == "" {
		return nil
	}
	status := "sent"
	errText := ""
	if postErr != nil {
		status = "failed"
		errText = postErr.Error()
		if len(errText) > 2000 {
			errText = errText[:2000]
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO notification_webhook_deliveries
    (tenant_id, user_id, notification_id, event_type, kind, status, error, attempts,
     delivered_at, next_retry_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 1,
        CASE WHEN $6 = 'sent' THEN now() END,
        CASE WHEN $6 = 'failed' THEN now() + interval '1 minute' END)
ON CONFLICT (tenant_id, notification_id, user_id) DO UPDATE
   SET status       = EXCLUDED.status,
       error        = EXCLUDED.error,
       kind         = EXCLUDED.kind,
       attempts     = notification_webhook_deliveries.attempts + 1,
       -- Preserved: the first time it landed is the fact worth keeping, and a
       -- later failed retry must not erase evidence that it once arrived.
       delivered_at = COALESCE(notification_webhook_deliveries.delivered_at, EXCLUDED.delivered_at),
       -- Cleared on success and on retirement; doubling from a minute while
       -- failing, capped so a long outage does not schedule the next attempt
       -- days out.
       next_retry_at = CASE
           WHEN EXCLUDED.status <> 'failed' THEN NULL
           WHEN notification_webhook_deliveries.attempts + 1 >= $8 THEN NULL
           ELSE now() + (interval '1 minute' *
                power(2, least(notification_webhook_deliveries.attempts, 6)))
       END,
       updated_at   = now()`,
		tenantID, userID, notificationID, eventType, kind, status, errText, MaxPostAttempts); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
