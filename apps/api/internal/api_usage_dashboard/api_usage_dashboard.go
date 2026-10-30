// SPDX-License-Identifier: AGPL-3.0-only
//
// Package api_usage_dashboard exposes per-tenant API usage
// aggregates over the api_key_usage table (migration 0019).
//
// The table stores one row per (api_key_id, period=date) with
// cumulative `sends` and `cost_cents` counters that the budgets
// middleware increments inline on every billed call. This package
// reads that data and slices it three ways:
//
//   GET /api/v1/api-usage/summary?days=30        per-tenant rollup
//   GET /api/v1/api-usage/keys?days=30           top keys + their totals
//   GET /api/v1/api-usage/timeseries?days=30     daily {date, sends, cost} points
//
// Everything is admin-scope; the same view feeds the in-product
// billing-and-quota dashboard and the operator-side "who's
// driving the bill" investigation.
//
// We don't depend on any other package's repo here — the table is
// the contract.

package api_usage_dashboard

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers the three read endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/api-usage/summary", d.Summary)
	r.With(read).Get("/api/v1/api-usage/keys", d.ByKey)
	r.With(read).Get("/api/v1/api-usage/timeseries", d.Timeseries)
}

// Summary GET /api/v1/api-usage/summary?days=30.
//
// Tenant-wide totals over the lookback window plus the same
// figures projected to a 30-day month so the operator can eyeball
// "where would we end up if today's rate holds".
func (d *Deps) Summary(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := parseDays(r, 30)
	since := time.Now().UTC().AddDate(0, 0, -days)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var totalSends, totalCostCents int64
	var activeKeys int
	err = tx.QueryRow(r.Context(), `
SELECT COALESCE(SUM(sends), 0),
       COALESCE(SUM(cost_cents), 0),
       COALESCE(COUNT(DISTINCT api_key_id), 0)
  FROM api_key_usage
 WHERE tenant_id = $1::uuid
   AND period >= $2::date`, t.ID, since).Scan(&totalSends, &totalCostCents, &activeKeys)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Daily averages + 30-day projection.
	dayCount := float64(days)
	if dayCount < 1 {
		dayCount = 1
	}
	avgSendsPerDay := float64(totalSends) / dayCount
	avgCostCentsPerDay := float64(totalCostCents) / dayCount

	writeJSON(w, http.StatusOK, map[string]any{
		"window_days":              days,
		"since":                    since.Format(time.RFC3339),
		"total_sends":              totalSends,
		"total_cost_cents":         totalCostCents,
		"active_keys":              activeKeys,
		"avg_sends_per_day":        avgSendsPerDay,
		"avg_cost_cents_per_day":   avgCostCentsPerDay,
		"projected_30d_sends":      int64(avgSendsPerDay * 30),
		"projected_30d_cost_cents": int64(avgCostCentsPerDay * 30),
	})
}

// ByKey GET /api/v1/api-usage/keys?days=30&limit=20.
//
// Joins api_key_usage to api_keys so the response includes the
// operator-facing label and prefix. Sorted by sends desc — the
// "who is driving traffic" question.
func (d *Deps) ByKey(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := parseDays(r, 30)
	since := time.Now().UTC().AddDate(0, 0, -days)
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT k.id::text, COALESCE(k.label, ''), COALESCE(k.prefix, ''),
       COALESCE(k.actor_type, 'human'),
       COALESCE(SUM(u.sends), 0)      AS sends,
       COALESCE(SUM(u.cost_cents), 0) AS cost_cents,
       MAX(u.period)                  AS last_active_period
  FROM api_keys k
  LEFT JOIN api_key_usage u
    ON u.api_key_id = k.id AND u.period >= $2::date
 WHERE k.tenant_id = $1::uuid
   AND k.revoked_at IS NULL
 GROUP BY k.id, k.label, k.prefix, k.actor_type
 ORDER BY sends DESC, k.id
 LIMIT $3`, t.ID, since, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type keyRow struct {
		ID               string     `json:"id"`
		Label            string     `json:"label"`
		Prefix           string     `json:"prefix"`
		ActorType        string     `json:"actor_type"`
		Sends            int64      `json:"sends"`
		CostCents        int64      `json:"cost_cents"`
		LastActivePeriod *time.Time `json:"last_active_period,omitempty"`
	}
	out := []keyRow{}
	for rows.Next() {
		var k keyRow
		if err := rows.Scan(&k.ID, &k.Label, &k.Prefix, &k.ActorType,
			&k.Sends, &k.CostCents, &k.LastActivePeriod); err != nil {
			continue
		}
		out = append(out, k)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"since":       since.Format(time.RFC3339),
		"keys":        out,
		"count":       len(out),
	})
}

// Timeseries GET /api/v1/api-usage/timeseries?days=30.
//
// Returns a dense per-day series (zero-filled for days with no
// activity) suitable for a sparkline. We expand the date range in
// SQL via generate_series so the front-end doesn't have to
// handle gaps.
func (d *Deps) Timeseries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := parseDays(r, 30)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
WITH series AS (
  SELECT generate_series(
    (CURRENT_DATE - ($2::int - 1))::date,
    CURRENT_DATE::date,
    INTERVAL '1 day'
  )::date AS period
)
SELECT s.period::text,
       COALESCE(SUM(u.sends), 0),
       COALESCE(SUM(u.cost_cents), 0)
  FROM series s
  LEFT JOIN api_key_usage u
    ON u.period = s.period AND u.tenant_id = $1::uuid
 GROUP BY s.period
 ORDER BY s.period`, t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type point struct {
		Date      string `json:"date"`
		Sends     int64  `json:"sends"`
		CostCents int64  `json:"cost_cents"`
	}
	out := []point{}
	for rows.Next() {
		var p point
		if err := rows.Scan(&p.Date, &p.Sends, &p.CostCents); err != nil {
			continue
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"points":      out,
	})
}

func parseDays(r *http.Request, def int) int {
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 365 {
			return n
		}
	}
	return def
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep errors imported for future typed sentinels.
var _ = errors.New
