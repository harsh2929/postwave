// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Delivery list reads (tenant-wide, per-webhook and keyset-paged) for the
// outbound webhook Store.

// ListAllDeliveries returns the most recent N deliveries across all
// webhooks for the tenant. Used by the inspector dashboard.
//
// Optional status filter narrows to pending | delivered | exhausted | skipped,
// or the derived "failing" view (exhausted plus pending rows with a recorded
// error). Empty status returns all. Handlers validate the public filter first.
func (s *Store) ListAllDeliveries(ctx context.Context, tenantID, status string, limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statusFilter := ""
	args := []any{tenantID}
	if status == "failing" {
		statusFilter = `
 AND (
     status = 'exhausted'
     OR (status = 'pending' AND last_error IS NOT NULL)
 )`
	} else if status != "" {
		statusFilter = " AND status = $2"
		args = append(args, status)
	}
	args = append(args, limit)
	sql := `
SELECT id::text, webhook_id::text, event_type, attempt_count, next_attempt_at,
       status, last_status_code, COALESCE(last_response_body_truncated,''),
       COALESCE(last_error,''), created_at, delivered_at
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid` + statusFilter + `
 ORDER BY created_at DESC
 LIMIT $` + strconv.Itoa(len(args))
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		var nextAt, deliveredAt *time.Time
		var statusCode *int
		if err := rows.Scan(
			&d.ID, &d.WebhookID, &d.EventType, &d.AttemptCount, &nextAt,
			&d.Status, &statusCode, &d.LastResponseBodyTruncated, &d.LastError,
			&d.CreatedAt, &deliveredAt,
		); err != nil {
			return nil, err
		}
		d.NextAttemptAt = nextAt
		d.DeliveredAt = deliveredAt
		d.LastStatusCode = statusCode
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListDeliveries returns the most recent N deliveries for a webhook,
// newest first.
func (s *Store) ListDeliveries(ctx context.Context, tenantID, webhookID string, limit int) ([]Delivery, error) {
	items, _, err := s.ListDeliveriesPage(ctx, tenantID, webhookID, limit, pagination.Cursor{})
	return items, err
}

// ListDeliveriesPage returns a stable newest-first page and an opaque cursor.
func (s *Store) ListDeliveriesPage(ctx context.Context, tenantID, webhookID string, limit int, cursor pagination.Cursor) ([]Delivery, string, error) {
	if limit <= 0 || limit > pagination.MaxLimit {
		limit = pagination.DefaultLimit
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var endpointExists bool
	if err := tx.QueryRow(ctx, `
SELECT true
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`,
		tenantID, webhookID,
	).Scan(&endpointExists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}
	args := []any{tenantID, webhookID}
	cursorPredicate := ""
	if cursor.ID != "" {
		cursorPredicate = " AND (created_at, id::text) < ($3::timestamptz, $4)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, `
SELECT id::text, webhook_id::text, event_type, attempt_count, next_attempt_at,
       status, last_status_code, COALESCE(last_response_body_truncated,''),
       COALESCE(last_error,''), created_at, delivered_at
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid AND webhook_id::text = $2
`+cursorPredicate+`
 ORDER BY created_at DESC, id::text DESC
 LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		var nextAt, deliveredAt *time.Time
		var statusCode *int
		if err := rows.Scan(
			&d.ID, &d.WebhookID, &d.EventType, &d.AttemptCount, &nextAt,
			&d.Status, &statusCode, &d.LastResponseBodyTruncated, &d.LastError,
			&d.CreatedAt, &deliveredAt,
		); err != nil {
			return nil, "", err
		}
		d.NextAttemptAt = nextAt
		d.DeliveredAt = deliveredAt
		d.LastStatusCode = statusCode
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	trimmed, hasMore := pagination.HasMore(out, limit)
	nextCursor := ""
	if hasMore && len(trimmed) > 0 {
		last := trimmed[len(trimmed)-1]
		nextCursor = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return trimmed, nextCursor, nil
}
