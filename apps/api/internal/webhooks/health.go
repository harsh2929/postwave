// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Health is the 24h aggregate health snapshot returned by
// GET /api/v1/webhooks/{id}/health. Refined Webhooks PR 1.
//
// Latency comes from the existing response_ms column on
// webhook_deliveries (already populated by the dispatcher), so this
// is a pure aggregation read — no schema changes.
type Health struct {
	DeliveriesTotal     int            `json:"deliveries_total"`
	DeliveriesSucceeded int            `json:"deliveries_succeeded"`
	DeliveriesFailed    int            `json:"deliveries_failed"`
	LatencyP50Ms        int            `json:"latency_p50_ms"`
	LatencyP99Ms        int            `json:"latency_p99_ms"`
	StatusBreakdown     map[string]int `json:"status_breakdown"`
	TopErrors           []TopError     `json:"top_errors"`
	ConsecutiveFailures int            `json:"consecutive_failures"`
	AutoDisabled        bool           `json:"auto_disabled"`
	LastDeliveryAt      *time.Time     `json:"last_delivery_at,omitempty"`
}

// TopError is one row in the "what's breaking" summary.
type TopError struct {
	StatusCode int    `json:"status_code"`
	Message    string `json:"message"`
	Count      int    `json:"count"`
}

// Health computes the 24h aggregate for a single webhook.
//
// Reads:
//  1. Subscription row for consecutive_failures + active (auto-disabled derivation)
//  2. Status counts in the 24h window
//  3. Latency samples (response_ms) for successful deliveries
//  4. Top errors by (status_code, error) bucket
func (r *Repo) Health(ctx context.Context, tenantID, webhookID string) (*Health, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &Health{
		StatusBreakdown: map[string]int{},
		TopErrors:       []TopError{},
	}

	// Subscription state — feeds auto_disabled + consecutive_failures.
	// Legacy webhooks table doesn't track consecutive_failures
	// natively, so we derive it from the trailing-tail-of-failures
	// count in the deliveries log. Auto-disabled = status='paused'
	// with > threshold consecutive failures.
	var status string
	err = tx.QueryRow(ctx, `
SELECT status FROM webhooks WHERE id::text = $1 AND tenant_id = $2::uuid`,
		webhookID, tenantID).Scan(&status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	consecutive, _ := r.trailingConsecutiveFailures(ctx, tx, webhookID)
	out.ConsecutiveFailures = consecutive
	out.AutoDisabled = status != "active" && consecutive >= autoDisabledThreshold

	// Status counts.
	rows, err := tx.Query(ctx, `
SELECT status_code, COUNT(*)::int
FROM webhook_deliveries
WHERE webhook_id::text = $1
  AND at >= now() - interval '24 hours'
GROUP BY status_code`, webhookID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var code, n int
		if err := rows.Scan(&code, &n); err != nil {
			rows.Close()
			return nil, err
		}
		out.DeliveriesTotal += n
		bucket := statusBucket(code)
		out.StatusBreakdown[bucket] += n
		if bucket == "2xx" {
			out.DeliveriesSucceeded += n
		} else {
			out.DeliveriesFailed += n
		}
	}
	rows.Close()

	// Latency samples (successes only).
	latRows, err := tx.Query(ctx, `
SELECT response_ms FROM webhook_deliveries
WHERE webhook_id::text = $1
  AND status_code BETWEEN 200 AND 299
  AND at >= now() - interval '24 hours'`, webhookID)
	if err != nil {
		return nil, err
	}
	latencies := []int{}
	for latRows.Next() {
		var ms int
		if err := latRows.Scan(&ms); err != nil {
			latRows.Close()
			return nil, err
		}
		if ms < 0 {
			ms = 0
		}
		latencies = append(latencies, ms)
	}
	latRows.Close()
	out.LatencyP50Ms = percentile(latencies, 0.50)
	out.LatencyP99Ms = percentile(latencies, 0.99)

	// Top errors.
	errRows, err := tx.Query(ctx, `
SELECT status_code, COALESCE(error, '') AS msg, COUNT(*)::int
FROM webhook_deliveries
WHERE webhook_id::text = $1
  AND at >= now() - interval '24 hours'
  AND (status_code = 0 OR status_code >= 400)
GROUP BY status_code, msg
ORDER BY COUNT(*) DESC
LIMIT 5`, webhookID)
	if err != nil {
		return nil, err
	}
	for errRows.Next() {
		var te TopError
		if err := errRows.Scan(&te.StatusCode, &te.Message, &te.Count); err != nil {
			errRows.Close()
			return nil, err
		}
		out.TopErrors = append(out.TopErrors, te)
	}
	errRows.Close()

	// Last delivery timestamp.
	var lastAt *time.Time
	_ = tx.QueryRow(ctx, `
SELECT MAX(at) FROM webhook_deliveries WHERE webhook_id::text = $1`, webhookID).Scan(&lastAt)
	out.LastDeliveryAt = lastAt

	return out, tx.Commit(ctx)
}

// trailingConsecutiveFailures walks the most-recent deliveries in
// reverse-chronological order and counts how many were non-2xx
// before the first 2xx. Capped at 200 to keep the query cheap.
func (r *Repo) trailingConsecutiveFailures(ctx context.Context, tx pgx.Tx, webhookID string) (int, error) {
	rows, err := tx.Query(ctx, `
SELECT status_code FROM webhook_deliveries
WHERE webhook_id::text = $1
ORDER BY at DESC
LIMIT 200`, webhookID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var code int
		if err := rows.Scan(&code); err != nil {
			return 0, err
		}
		if code >= 200 && code < 300 {
			break
		}
		n++
	}
	return n, rows.Err()
}

// ReEnable flips status back to "active". Idempotent.
func (r *Repo) ReEnable(ctx context.Context, tenantID, webhookID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE webhooks SET status = 'active', updated_at = now()
WHERE id::text = $1`, webhookID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

const autoDisabledThreshold = 100

func statusBucket(code int) string {
	switch {
	case code == 0:
		return "error"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	default:
		return "error"
	}
}

func percentile(values []int, p float64) int {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	if p <= 0 {
		return sorted[0]
	}
	if p >= 1 {
		return sorted[len(sorted)-1]
	}
	idx := p * float64(len(sorted)-1)
	low := int(idx)
	high := low + 1
	if high >= len(sorted) {
		return sorted[low]
	}
	frac := idx - float64(low)
	return int(float64(sorted[low]) + frac*float64(sorted[high]-sorted[low]))
}

// HealthHandler GET /api/v1/webhooks/{id}/health
func (d *Deps) HealthHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.Repo.Health(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ReEnableHandler POST /api/v1/webhooks/{id}/re-enable
func (d *Deps) ReEnableHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.ReEnable(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
