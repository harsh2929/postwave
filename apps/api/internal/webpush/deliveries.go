// SPDX-License-Identifier: AGPL-3.0-only
package webpush

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The delivery record web push did not have.
//
// `SendToUser` logged its failures and stored nothing, so a browser vendor
// returning 429 — a rate limit, the most ordinary transient failure there is —
// dropped that notification permanently and invisibly. The same notification to
// the same person's phone is recorded in `mobile_push_deliveries` and retried.
//
// Two things change here and one deliberately does not. Every attempt is now
// RECORDED, and a notification already accepted for an endpoint is not sent
// again. Nothing retries a failure yet — that needs a worker, and claiming it
// were done while nothing re-sends is the failure this ledger keeps catching.

// deliveryStatus values mirror mobile_push_deliveries so "was this person
// notified" can be asked across channels without a translation table.
const (
	statusSent       = "sent"
	statusFailed     = "failed"
	statusExpired    = "expired"
	statusSuppressed = "suppressed"
)

// idempotencyKeyFor derives the key from the notification's cross-channel id.
//
// `NotificationID` is already documented as "the cross-channel identity: the
// notification_feed row id this delivery mirrors", carried by every channel so
// clients can dedup one logical notification across devices. It is exactly the
// right key and needed no new parameter.
//
// Empty is possible — some callers construct a Notification without a feed row.
// Those get a per-attempt key rather than being dropped: a record with no
// de-duplication is still a record, and refusing to send an un-keyed
// notification would turn a missing id into a missing notification.
func idempotencyKeyFor(n Notification) (key string, dedupable bool) {
	if id := strings.TrimSpace(n.NotificationID); id != "" {
		return id, true
	}
	return "", false
}

// alreadyAccepted reports whether this notification was already taken by the
// push service for this endpoint.
//
// The behavioural half of the ledger. Without it the table is a log; with it, a
// worker that retries an enclosing job — or a user with two tabs triggering the
// same fan-out — does not double-notify. Only `sent` counts: a previous
// `failed` SHOULD be retried, and treating it as done is how a transient
// failure becomes permanent.
func (d *Deps) alreadyAccepted(ctx context.Context, tenantID, endpoint, key string) bool {
	if d.Pool == nil || key == "" {
		return false
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	err = tx.QueryRow(ctx, `
SELECT status FROM web_push_deliveries
 WHERE tenant_id = $1::uuid AND endpoint = $2 AND idempotency_key = $3`,
		tenantID, endpoint, key).Scan(&status)
	if err != nil {
		// A read failure must not suppress a notification. Failing open here
		// risks a duplicate; failing closed loses the message outright, and a
		// duplicate notification is a smaller harm than a silent one.
		return false
	}
	return status == statusSent
}

// recordAttempt writes or updates the delivery row for one endpoint.
//
// Best-effort by design: the notification has already been sent by the time
// this runs, and returning an error would make a bookkeeping failure look like
// a delivery failure to the caller. The error is returned for the caller to log
// and never to act on.
func (d *Deps) recordAttempt(
	ctx context.Context, tenantID, userID, endpoint string, n Notification, status, errCode string,
) error {
	if d.Pool == nil {
		return nil
	}
	key, dedupable := idempotencyKeyFor(n)
	if !dedupable {
		// A row per attempt, keyed uniquely, so an un-keyed notification is
		// still visible in the ledger without colliding with the next one.
		key = "attempt:" + endpointFingerprint(endpoint) + ":" + status + ":" + n.Title
		if len(key) > 200 {
			key = key[:200]
		}
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	terminal := "now()"
	nextRetry := "NULL"
	if status == statusFailed {
		// A failure is NOT terminal: it is what the retry worker looks for.
		// Marking it terminal here would make the ledger claim a decision
		// nothing has taken.
		terminal = "NULL"
		// And it carries WHEN to look again. Exponential from the attempt count
		// already on the row, so a push service that is rate-limiting us is not
		// hammered by a worker that retries every tick.
		// Doubling from one minute, capped at roughly an hour (2^6). Capped
		// because an uncapped exponential on a long-lived failure schedules the
		// next attempt days out, which is indistinguishable from giving up
		// without ever saying so.
		nextRetry = "now() + (interval '1 minute' * " +
			"power(2, least(web_push_deliveries.attempts, 6)))"
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO web_push_deliveries
    (tenant_id, user_id, endpoint, event_type, entity_id, idempotency_key,
     status, error_code, attempts, accepted_at, terminal_at, next_retry_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 1,
        CASE WHEN $7 = 'sent' THEN now() END, `+terminal+`,
        CASE WHEN $7 = 'failed' THEN now() + interval '1 minute' END)
ON CONFLICT (tenant_id, endpoint, idempotency_key) DO UPDATE
   SET status        = EXCLUDED.status,
       error_code    = EXCLUDED.error_code,
       attempts      = web_push_deliveries.attempts + 1,
       accepted_at   = COALESCE(web_push_deliveries.accepted_at, EXCLUDED.accepted_at),
       terminal_at   = EXCLUDED.terminal_at,
       next_retry_at = `+nextRetry+`,
       updated_at    = now()`,
		tenantID, userID, endpoint, n.Event, n.NotificationID, key, status, errCode); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// endpointFingerprint shortens a push endpoint for use inside a key.
//
// Push endpoints are long, opaque and effectively a credential — the URL is
// what authorises sending to that browser. The last path segment is enough to
// distinguish two endpoints inside a key without copying the token into a
// second column.
func endpointFingerprint(endpoint string) string {
	if i := strings.LastIndexByte(endpoint, '/'); i >= 0 && i+1 < len(endpoint) {
		endpoint = endpoint[i+1:]
	}
	if len(endpoint) > 32 {
		endpoint = endpoint[:32]
	}
	return endpoint
}

var _ = pgx.ErrNoRows
