// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// OutboundHealth is the 24h aggregate health snapshot returned by
// GET /api/v1/outbound-webhooks/{id}/health. Refined Webhooks PR 1.
//
// All durations are in milliseconds; counts are over the trailing
// 24h window. Latency is end-to-end (queue wait + network) computed
// from delivered_at - created_at on successful deliveries.
type OutboundHealth struct {
	DeliveriesTotal     int            `json:"deliveries_total"`
	DeliveriesSucceeded int            `json:"deliveries_succeeded"`
	DeliveriesFailed    int            `json:"deliveries_failed"`
	DeliveriesPending   int            `json:"deliveries_pending"`
	DeliveriesSkipped   int            `json:"deliveries_skipped"`
	LatencyP50Ms        int            `json:"latency_p50_ms"`
	LatencyP99Ms        int            `json:"latency_p99_ms"`
	StatusBreakdown     map[string]int `json:"status_breakdown"`
	TopErrors           []TopError     `json:"top_errors"`
	ConsecutiveFailures int            `json:"consecutive_failures"`
	AutoDisabled        bool           `json:"auto_disabled"`
	DisabledReason      string         `json:"disabled_reason,omitempty"`
	DisabledAt          *time.Time     `json:"disabled_at,omitempty"`
	LastSucceededAt     *time.Time     `json:"last_succeeded_at,omitempty"`
	LastFailedAt        *time.Time     `json:"last_failed_at,omitempty"`
}

// TopError is one row in the "what's breaking" summary.
type TopError struct {
	StatusCode int    `json:"status_code"`
	Message    string `json:"message"`
	Count      int    `json:"count"`
}

// autoDisabledThreshold mirrors the worker's hard limit. Kept in
// sync via this single constant so the UI matches reality.
const autoDisabledThreshold = AutoDisableThreshold

// Health computes the 24h aggregate for a single subscription.
//
// Two queries:
//  1. Status counts + latency samples (single GROUP BY scan)
//  2. Top errors by (status_code, last_error) bucket
//
// Both use the existing (next_attempt_at) PARTIAL + (webhook_id,
// created_at DESC) indexes — bounded by created_at >= now() - 24h.
func (s *Store) Health(ctx context.Context, tenantID, webhookID string) (*OutboundHealth, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &OutboundHealth{
		StatusBreakdown: map[string]int{},
		TopErrors:       []TopError{},
	}

	// Source-of-truth fields live on the subscription row.
	var active bool
	var consecutive int
	var lastSucceeded, lastFailed, disabledAt *time.Time
	var disabledReason *string
	err = tx.QueryRow(ctx, `
SELECT active, consecutive_failures, last_succeeded_at, last_failed_at,
       disabled_reason, disabled_at
FROM outbound_webhooks
WHERE id::text = $1
  AND tenant_id = $2::uuid
  AND deleted_at IS NULL`, webhookID, tenantID).
		Scan(&active, &consecutive, &lastSucceeded, &lastFailed, &disabledReason, &disabledAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out.ConsecutiveFailures = consecutive
	out.LastSucceededAt = lastSucceeded
	out.LastFailedAt = lastFailed
	if disabledReason != nil {
		out.DisabledReason = *disabledReason
	}
	out.DisabledAt = disabledAt
	out.AutoDisabled = !active &&
		(out.DisabledReason == "auto_failures" ||
			(out.DisabledReason == "" && consecutive >= autoDisabledThreshold))

	// Status totals.
	rows, err := tx.Query(ctx, `
SELECT status,
       COUNT(*)::int AS n
FROM outbound_webhook_deliveries
WHERE webhook_id::text = $1
  AND tenant_id = $2::uuid
  AND created_at >= now() - interval '24 hours'
GROUP BY status`, webhookID, tenantID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			rows.Close()
			return nil, err
		}
		out.DeliveriesTotal += n
		switch status {
		case "delivered":
			out.DeliveriesSucceeded = n
		case "exhausted":
			out.DeliveriesFailed += n
		case "pending":
			out.DeliveriesPending = n
		case "skipped":
			out.DeliveriesSkipped = n
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Latency samples — collect all delivered-row latencies and
	// compute exact p50/p99 in app code. Bounded list (24h × N
	// webhooks rarely exceeds a few thousand rows per call).
	latRows, err := tx.Query(ctx, `
SELECT (EXTRACT(EPOCH FROM (delivered_at - created_at)) * 1000)::int
FROM outbound_webhook_deliveries
WHERE webhook_id::text = $1
  AND tenant_id = $2::uuid
  AND status = 'delivered'
  AND delivered_at IS NOT NULL
  AND created_at >= now() - interval '24 hours'`, webhookID, tenantID)
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
	if err := latRows.Err(); err != nil {
		latRows.Close()
		return nil, err
	}
	latRows.Close()
	out.LatencyP50Ms = percentile(latencies, 0.50)
	out.LatencyP99Ms = percentile(latencies, 0.99)

	// Status-code breakdown buckets.
	codeRows, err := tx.Query(ctx, `
SELECT COALESCE(last_status_code, 0)::int AS code, COUNT(*)::int AS n
FROM outbound_webhook_deliveries
WHERE webhook_id::text = $1
  AND tenant_id = $2::uuid
  AND created_at >= now() - interval '24 hours'
  AND last_status_code IS NOT NULL
GROUP BY code`, webhookID, tenantID)
	if err != nil {
		return nil, err
	}
	for codeRows.Next() {
		var code, n int
		if err := codeRows.Scan(&code, &n); err != nil {
			codeRows.Close()
			return nil, err
		}
		out.StatusBreakdown[statusBucket(code)] += n
	}
	if err := codeRows.Err(); err != nil {
		codeRows.Close()
		return nil, err
	}
	codeRows.Close()

	// Top errors — group by (last_status_code, last_error), keep 5.
	errRows, err := tx.Query(ctx, `
SELECT COALESCE(last_status_code, 0)::int AS code,
       COALESCE(last_error, '')           AS msg,
       COUNT(*)::int                      AS n
FROM outbound_webhook_deliveries
WHERE webhook_id::text = $1
  AND tenant_id = $2::uuid
  AND created_at >= now() - interval '24 hours'
  AND (
      status = 'exhausted'
      OR (
          status <> 'skipped'
          AND (
              last_error IS NOT NULL
              OR (last_status_code IS NOT NULL AND last_status_code >= 400)
          )
      )
  )
GROUP BY code, msg
ORDER BY n DESC
LIMIT 5`, webhookID, tenantID)
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
	if err := errRows.Err(); err != nil {
		errRows.Close()
		return nil, err
	}
	errRows.Close()

	return out, tx.Commit(ctx)
}

// ReEnable flips active=true and zeroes consecutive_failures so the
// worker resumes attempts. PR 1 — closes the loop on auto-disabled
// webhooks. Idempotent: re-enabling a healthy webhook is a no-op.
func (s *Store) ReEnable(ctx context.Context, tenantID, webhookID string) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		authState     string
		urlState      string
		filterExpr    *string
		transformJSON []byte
	)
	err = tx.QueryRow(ctx, `
SELECT auth_config_state, COALESCE(url_state, 'legacy_pending'),
       filter_expression, transform_template
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`,
		tenantID, webhookID,
	).Scan(&authState, &urlState, &filterExpr, &transformJSON)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	switch authState {
	case authConfigStateReady:
	case authConfigStateLegacyPending:
		return ErrAuthConfigPending
	default:
		return ErrAuthConfigInvalid
	}
	switch urlState {
	case destinationStateReady:
	case destinationStateLegacyPending:
		return ErrDestinationPending
	default:
		return ErrDestinationInvalid
	}
	if filterExpr != nil && strings.TrimSpace(*filterExpr) != "" {
		if _, err := ParseFilter(*filterExpr); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidFilter, err)
		}
	}
	if len(transformJSON) > 0 {
		var transform map[string]any
		if err := json.Unmarshal(transformJSON, &transform); err != nil {
			return fmt.Errorf("%w: decode: %v", ErrInvalidTransform, err)
		}
		if err := ValidateTransform(transform); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidTransform, err)
		}
	}
	var id string
	err = tx.QueryRow(ctx, `
UPDATE outbound_webhooks
SET active = true,
    consecutive_failures = 0,
    disabled_reason = NULL,
    disabled_at = NULL,
    updated_at = now(),
    config_version = config_version + CASE WHEN active THEN 0 ELSE 1 END
WHERE tenant_id = $1::uuid
  AND id::text = $2
  AND deleted_at IS NULL
  AND auth_config_state = 'ready'
  AND url_state = 'ready'
RETURNING id::text`, tenantID, webhookID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if err := resumePausedDeliveries(ctx, tx, tenantID, id); err != nil {
		return err
	}
	if err := finalizeOperatorNotifications(
		ctx,
		tx,
		tenantID,
		id,
		"endpoint re-enabled before notification delivery",
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// statusBucket coerces an HTTP status code into a coarse bucket
// label ("2xx" / "3xx" / "4xx" / "5xx" / "error"). 0 → "error"
// for our purpose (network failure with no response).
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

// percentile returns the p-th percentile (linear interpolation)
// of values. Returns 0 for an empty slice.
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

// Health GET /api/v1/outbound-webhooks/{id}/health
func (d *Deps) Health(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("store_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.Store.Health(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "webhook not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ReEnable POST /api/v1/outbound-webhooks/{id}/re-enable
func (d *Deps) ReEnable(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("store_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Store.ReEnable(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		if errors.Is(err, ErrAuthConfigPending) || errors.Is(err, ErrAuthConfigInvalid) {
			writeJSON(w, http.StatusConflict, errEnv(
				"receiver_auth_unavailable",
				"replace or clear receiver authentication before re-enabling this webhook",
			))
			return
		}
		if errors.Is(err, ErrDestinationPending) || errors.Is(err, ErrDestinationInvalid) {
			writeJSON(w, http.StatusConflict, errEnv(
				"destination_unavailable",
				"replace the destination URL before re-enabling this webhook",
			))
			return
		}
		if errors.Is(err, ErrInvalidFilter) ||
			errors.Is(err, ErrInvalidTransform) ||
			errors.Is(err, ErrDeliveryPolicyInvalid) {
			writeJSON(w, http.StatusConflict, errEnv(
				"delivery_configuration_invalid",
				"repair the event filter or payload transform before re-enabling this webhook",
			))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
