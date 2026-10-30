// SPDX-License-Identifier: AGPL-3.0-only
//
// Package growth_source surfaces "where are subscribers coming
// from?" — the single most useful list-growth metric an ESP
// reports to operators.
//
// The data:
//   subscribers.consent_source (one of 'double_optin' |
//     'single_optin' | 'import' | 'api' | 'unknown')
//   subscribers.source_platform, source_id (free-form provenance
//     from the migration adapter)
//   subscribers.created_at
//
// Three lenses on the same data:
//
//   1. summary             totals + per-source counts over a window
//   2. timeseries          daily new subscribers, grouped by source
//   3. quality_by_source   per-source bounce/complaint/engagement
//                          rates → "is this source actually good?"
//
// Surfaces:
//
//   GET /api/v1/growth-source/summary        ?days=30
//   GET /api/v1/growth-source/timeseries     ?days=30
//   GET /api/v1/growth-source/quality        ?days=90

package growth_source

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
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the read endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/growth-source/summary", d.Summary)
	r.With(read).Get("/api/v1/growth-source/timeseries", d.Timeseries)
	r.With(read).Get("/api/v1/growth-source/quality", d.Quality)
}

// Summary GET /api/v1/growth-source/summary?days=30.
func (d *Deps) Summary(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
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
	rows, err := tx.Query(r.Context(), `
SELECT consent_source, COALESCE(source_platform, ''), count(*) AS n
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND created_at >= $2
 GROUP BY consent_source, source_platform
 ORDER BY n DESC`, t.ID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type bucket struct {
		ConsentSource  string `json:"consent_source"`
		SourcePlatform string `json:"source_platform,omitempty"`
		Count          int64  `json:"count"`
	}
	out := []bucket{}
	var total int64
	for rows.Next() {
		var b bucket
		if err := rows.Scan(&b.ConsentSource, &b.SourcePlatform, &b.Count); err == nil {
			total += b.Count
			out = append(out, b)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days":    days,
		"since":          since.Format(time.RFC3339),
		"sources":        out,
		"total_new_subs": total,
	})
}

// Timeseries GET /api/v1/growth-source/timeseries?days=30.
//
// Dense daily series via generate_series — zero-filled for days
// without signups so the front-end doesn't have to gap-fill.
func (d *Deps) Timeseries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
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
  )::date AS day
)
SELECT s.day::text,
       COALESCE(consent_source, '') AS src,
       COALESCE(count(sub.id), 0)::int8 AS n
  FROM series s
  LEFT JOIN subscribers sub
    ON sub.tenant_id = $1::uuid
   AND sub.created_at::date = s.day
 GROUP BY s.day, consent_source
 ORDER BY s.day, src`, t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type point struct {
		Date          string `json:"date"`
		ConsentSource string `json:"consent_source"`
		Count         int64  `json:"count"`
	}
	out := []point{}
	for rows.Next() {
		var p point
		if err := rows.Scan(&p.Date, &p.ConsentSource, &p.Count); err == nil {
			out = append(out, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"points":      out,
	})
}

// Quality GET /api/v1/growth-source/quality?days=90.
//
// Per-source rollup of subscriber quality: bounce rate, complaint
// rate, engaged rate. Answers "which signup channels deliver
// subscribers that actually convert" — the gold metric for
// allocating growth budget.
func (d *Deps) Quality(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
		return
	}
	days := parseDays(r, 90)
	since := time.Now().UTC().AddDate(0, 0, -days)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
WITH src AS (
  SELECT id, email, consent_source
    FROM subscribers
   WHERE tenant_id = $1::uuid AND created_at >= $2
)
SELECT s.consent_source,
       count(DISTINCT s.id) AS total,
       count(DISTINCT s.id) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM subscriber_events e
            WHERE e.tenant_id = $1::uuid
              AND e.subscriber_email = s.email
              AND e.event_type IN ('opened','clicked') AND e.at >= $2)
       ) AS engaged,
       count(DISTINCT s.id) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM subscriber_events e
            WHERE e.tenant_id = $1::uuid
              AND e.subscriber_email = s.email
              AND e.event_type = 'bounced' AND e.at >= $2)
       ) AS bounced,
       count(DISTINCT s.id) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM subscriber_events e
            WHERE e.tenant_id = $1::uuid
              AND e.subscriber_email = s.email
              AND e.event_type = 'complained' AND e.at >= $2)
       ) AS complained
  FROM src s
 GROUP BY s.consent_source
 ORDER BY total DESC`, t.ID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type row struct {
		ConsentSource    string  `json:"consent_source"`
		TotalSubscribers int64   `json:"total_subscribers"`
		Engaged          int64   `json:"engaged"`
		Bounced          int64   `json:"bounced"`
		Complained       int64   `json:"complained"`
		EngagementRate   float64 `json:"engagement_rate"`
		BounceRate       float64 `json:"bounce_rate"`
		ComplaintRate    float64 `json:"complaint_rate"`
	}
	out := []row{}
	for rows.Next() {
		var rw row
		if err := rows.Scan(&rw.ConsentSource, &rw.TotalSubscribers,
			&rw.Engaged, &rw.Bounced, &rw.Complained); err != nil {
			continue
		}
		den := float64(rw.TotalSubscribers)
		if den == 0 {
			den = 1
		}
		rw.EngagementRate = float64(rw.Engaged) / den
		rw.BounceRate = float64(rw.Bounced) / den
		rw.ComplaintRate = float64(rw.Complained) / den
		out = append(out, rw)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"sources":     out,
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

var _ = errors.New
