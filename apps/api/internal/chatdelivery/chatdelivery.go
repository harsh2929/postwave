// SPDX-License-Identifier: AGPL-3.0-only

// Package chatdelivery is the shared durable delivery log for the chat
// integrations (Slack / Discord / Teams). Each provider's outbox handler and
// "Send test" path appends one row per attempt (INTG-033 Slice B) so operators
// can list a history rather than only the last overwritten status. The three
// provider packages keep their own tables/repos; only this cross-cutting log is
// shared to avoid triplicating the SQL.
package chatdelivery

import (
	"context"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Delivery is one logged delivery attempt.
type Delivery struct {
	ID            string    `json:"id"`
	Provider      string    `json:"provider"`
	IntegrationID string    `json:"integration_id"`
	EventType     string    `json:"event_type"`
	Status        string    `json:"status"` // "success" | "failed"
	Error         string    `json:"error,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// Log appends a delivery row. It is best-effort: callers append AFTER the real
// delivery + RecordOutcome, so a logging failure must never fail the delivery —
// the returned error is for observability only. Runs under the caller's tenant
// scope (db.WithTenant), matching how RecordOutcome writes.
// AlreadyDelivered reports whether this outbox event was already posted
// successfully to this integration.
//
// The outbox is at-least-once: the handler posts, then the worker marks the
// event complete, and a crash or lease expiry between the two redelivers it. The
// handler then posts again, and `chat_delivery_log` — written after the fact —
// records two successes without being able to say they were one notification.
//
// Fails OPEN. A read error here returns false and the message is sent, because a
// duplicate chat message is an annoyance and a missing one is a person not
// finding out their campaign needs approval.
//
// eventID empty means there is no outbox event — the operator-triggered "Send
// test" path — and a second click there is meant to send a second message.
func AlreadyDelivered(ctx context.Context, pool *db.Pool, tenantID, integrationID, eventID string) bool {
	if pool == nil || strings.TrimSpace(eventID) == "" {
		return false
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM chat_delivery_log
   WHERE tenant_id = $1::uuid AND integration_id = $2::uuid
     AND outbox_event_id = $3::uuid AND status = 'success')`,
		tenantID, integrationID, eventID).Scan(&exists); err != nil {
		return false
	}
	return exists
}

// LogEvent is Log with the outbox event this delivery was for.
//
// A separate entry point rather than a signature change: the "Send test" path
// legitimately has no event, and giving it a parameter it must pass "" for
// invites someone to pass a made-up value.
func LogEvent(ctx context.Context, pool *db.Pool, tenantID, provider, integrationID, eventType, eventID string, deliveryErr error) error {
	return logDelivery(ctx, pool, tenantID, provider, integrationID, eventType, eventID, deliveryErr)
}

func Log(ctx context.Context, pool *db.Pool, tenantID, provider, integrationID, eventType string, deliveryErr error) error {
	return logDelivery(ctx, pool, tenantID, provider, integrationID, eventType, "", deliveryErr)
}

func logDelivery(ctx context.Context, pool *db.Pool, tenantID, provider, integrationID, eventType, eventID string, deliveryErr error) error {
	status := "success"
	var errMsg any
	if deliveryErr != nil {
		status = "failed"
		msg := deliveryErr.Error()
		if len(msg) > 1024 {
			msg = msg[:1024]
		}
		errMsg = msg
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var eventIDArg any
	if strings.TrimSpace(eventID) != "" {
		eventIDArg = eventID
	}
	// ON CONFLICT DO NOTHING against the partial unique index: two workers
	// racing the same redelivered event must not both write a success row, and
	// the loser must not turn a delivered message into an error the caller
	// reports.
	if _, err := tx.Exec(ctx, `
INSERT INTO chat_delivery_log
    (tenant_id, provider, integration_id, event_type, status, error, outbox_event_id)
VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::uuid)
ON CONFLICT DO NOTHING`,
		tenantID, provider, integrationID, eventType, status, errMsg, eventIDArg); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// List returns the most recent deliveries for one integration, newest first,
// capped at limit (defaulted/clamped to a sane range).
func List(ctx context.Context, pool *db.Pool, tenantID, integrationID string, limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, provider, integration_id::text, event_type, status,
       COALESCE(error, ''), created_at
  FROM chat_delivery_log
 WHERE tenant_id = $1::uuid AND integration_id = $2::uuid
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, integrationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.Provider, &d.IntegrationID, &d.EventType,
			&d.Status, &d.Error, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
