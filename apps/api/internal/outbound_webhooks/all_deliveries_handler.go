// SPDX-License-Identifier: AGPL-3.0-only
//
// all_deliveries_handler.go — unified webhook-delivery dashboard.
//
// Per-webhook ListDeliveries already exists. This file adds:
//
//   GET /api/v1/outbound-webhooks/deliveries
//        Cross-webhook stream of recent deliveries. Filterable by
//        ?status=failing, ?status=delivered, ?webhook_id=, ?since=,
//        ?event_type=. The dashboard wants "show me everything
//        broken right now" — that's a 1-query view that the
//        per-webhook surface can't satisfy.
//
//   GET /api/v1/outbound-webhooks/deliveries/stats
//        Per-(webhook, event_type) success/failure counts over the
//        last 24h. Powers the dashboard's overview tile.

package outbound_webhooks

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountUnifiedDeliveriesRoutes registers the richer cross-webhook
// endpoints. /deliveries itself is already mounted by handlers.go's
// AllDeliveries (basic status+limit filter); this adds the
// multi-filter search + the overview stats roll-up the dashboard
// needs.
//
//	GET /api/v1/outbound-webhooks/deliveries/search  — multi-filter
//	     search with webhook URL join (status, event_type,
//	     webhook_id, since=RFC3339, limit).
//	GET /api/v1/outbound-webhooks/deliveries/stats   — 24h aggregate
//	     per (webhook, event_type).
func (d *Deps) MountUnifiedDeliveriesRoutes(r chi.Router) {
	if d == nil || d.Store == nil {
		return
	}
	// Delivery diagnostics can contain subscriber data and a bounded receiver
	// response preview. Keep this aligned with the canonical delivery-list
	// routes: reports-only keys must not gain access to integration payloads.
	read := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/outbound-webhooks/deliveries/search", d.SearchDeliveries)
	r.With(read).Get("/api/v1/outbound-webhooks/deliveries/stats", d.DeliveryStats)
}

// UnifiedDelivery is the wire shape — adds the webhook URL for
// quick visual association (the per-webhook list already has the id
// in context).
type UnifiedDelivery struct {
	ID                        string     `json:"id"`
	WebhookID                 string     `json:"webhook_id"`
	WebhookURL                string     `json:"webhook_url"`
	EventType                 string     `json:"event_type"`
	AttemptCount              int        `json:"attempt_count"`
	NextAttemptAt             *time.Time `json:"next_attempt_at,omitempty"`
	Status                    string     `json:"status"`
	LastStatusCode            *int       `json:"last_status_code,omitempty"`
	LastResponseBodyTruncated string     `json:"last_response_body_truncated,omitempty"`
	LastError                 string     `json:"last_error,omitempty"`
	CreatedAt                 time.Time  `json:"created_at"`
	DeliveredAt               *time.Time `json:"delivered_at,omitempty"`
}

// SearchDeliveries GET /api/v1/outbound-webhooks/deliveries/search.
// Multi-filter cross-webhook search with the webhook URL joined in.
func (d *Deps) SearchDeliveries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	q := r.URL.Query()
	status := strings.TrimSpace(q.Get("status"))
	eventType := strings.TrimSpace(q.Get("event_type"))
	webhookID := strings.TrimSpace(q.Get("webhook_id"))
	since := strings.TrimSpace(q.Get("since"))
	switch status {
	case "", "pending", "delivered", "exhausted", "skipped", "failing":
	default:
		httperror.WriteValidation(
			w,
			"invalid_status",
			"status must be pending, delivered, exhausted, skipped, or failing",
		)
		return
	}
	if webhookID != "" {
		if _, err := uuid.Parse(webhookID); err != nil {
			httperror.WriteValidation(w, "invalid_webhook_id", "webhook_id must be a UUID")
			return
		}
	}
	var sinceAt any
	if since != "" {
		parsed, err := time.Parse(time.RFC3339, since)
		if err != nil {
			httperror.WriteValidation(w, "invalid_since", "since must be an RFC3339 timestamp")
			return
		}
		sinceAt = parsed
	}
	limit := 100
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 500 {
			httperror.WriteValidation(w, "invalid_limit", "limit must be between 1 and 500")
			return
		}
		limit = n
	}

	tx, err := db.WithTenant(r.Context(), d.Store.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Single query joining deliveries → webhooks for the URL field.
	// All filters are optional; the SQL uses NULLIF + IS NULL OR for
	// the conditional WHERE without splitting the query.
	rows, err := tx.Query(r.Context(), `
SELECT d.id::text, d.webhook_id::text, COALESCE(w.url, ''),
       d.event_type, d.attempt_count, d.next_attempt_at,
       d.status, d.last_status_code,
       COALESCE(d.last_response_body_truncated, ''),
       COALESCE(d.last_error, ''),
       d.created_at, d.delivered_at
  FROM outbound_webhook_deliveries d
  LEFT JOIN outbound_webhooks w
    ON w.id = d.webhook_id AND w.tenant_id = d.tenant_id
 WHERE d.tenant_id = $1::uuid
   AND (
       $2 = ''
       OR (
           $2 = 'failing'
           AND (
               d.status = 'exhausted'
               OR (d.status = 'pending' AND d.last_error IS NOT NULL)
           )
       )
       OR ($2 <> 'failing' AND d.status = $2)
   )
   AND ($3 = '' OR d.event_type = $3)
   AND ($4 = '' OR d.webhook_id::text = $4)
   AND ($5::timestamptz IS NULL OR d.created_at >= $5::timestamptz)
 ORDER BY d.created_at DESC
 LIMIT $6`,
		t.ID, status, eventType, webhookID, sinceAt, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []UnifiedDelivery{}
	for rows.Next() {
		var u UnifiedDelivery
		var nextAt, deliveredAt *time.Time
		var statusCode *int
		if err := rows.Scan(&u.ID, &u.WebhookID, &u.WebhookURL,
			&u.EventType, &u.AttemptCount, &nextAt,
			&u.Status, &statusCode, &u.LastResponseBodyTruncated,
			&u.LastError, &u.CreatedAt, &deliveredAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		// Legacy rows may still hold the complete capability URL while the
		// envelope rewrap worker is draining. The public read projection never
		// exposes path/query values, regardless of migration state.
		u.WebhookURL = destinationDisplay(u.WebhookURL)
		u.NextAttemptAt = nextAt
		u.DeliveredAt = deliveredAt
		u.LastStatusCode = statusCode
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deliveries": out, "count": len(out)})
}

// DeliveryStatsRow is one (webhook, event_type) summary.
type DeliveryStatsRow struct {
	WebhookID  string `json:"webhook_id"`
	WebhookURL string `json:"webhook_url"`
	EventType  string `json:"event_type"`
	Total      int64  `json:"total"`
	Delivered  int64  `json:"delivered"`
	Failed     int64  `json:"failed"`
	Pending    int64  `json:"pending"`
	Skipped    int64  `json:"skipped"`
}

// DeliveryStats GET /api/v1/outbound-webhooks/deliveries/stats — 24h
// aggregate per (webhook, event_type). Powers the dashboard
// overview row.
func (d *Deps) DeliveryStats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT d.webhook_id::text, COALESCE(w.url, ''), d.event_type,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE d.status = 'delivered') AS delivered,
       COUNT(*) FILTER (
           WHERE d.status = 'exhausted'
              OR (d.status = 'pending' AND d.last_error IS NOT NULL)
       ) AS failed,
       COUNT(*) FILTER (WHERE d.status = 'pending')   AS pending,
       COUNT(*) FILTER (WHERE d.status = 'skipped')   AS skipped
  FROM outbound_webhook_deliveries d
  LEFT JOIN outbound_webhooks w
    ON w.id = d.webhook_id AND w.tenant_id = d.tenant_id
 WHERE d.tenant_id = $1::uuid
   AND d.created_at > now() - INTERVAL '24 hours'
 GROUP BY d.webhook_id, w.url, d.event_type
 ORDER BY total DESC
 LIMIT 200`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []DeliveryStatsRow{}
	for rows.Next() {
		var s DeliveryStatsRow
		if err := rows.Scan(&s.WebhookID, &s.WebhookURL, &s.EventType,
			&s.Total, &s.Delivered, &s.Failed, &s.Pending, &s.Skipped); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		s.WebhookURL = destinationDisplay(s.WebhookURL)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": out})
}
