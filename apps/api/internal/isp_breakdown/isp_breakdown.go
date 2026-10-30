// SPDX-License-Identifier: AGPL-3.0-only
//
// Package isp_breakdown surfaces engagement metrics grouped by
// recipient ISP — gmail.com vs outlook.com vs yahoo.com vs the
// long tail of B2B domains.
//
// Why this is actionable: deliverability problems are usually
// ISP-specific. Gmail might inbox at 95% while Yahoo trips spam
// at 60% — and the tenant-wide open rate hides it. The breakdown
// lets the operator see "we have a Yahoo problem", not "our open
// rate is low".
//
// We normalize against a small whitelist of high-volume providers
// so 60% of the audience that's on gmail.com / outlook.com /
// yahoo.com / icloud.com / proton.me etc. shows up explicitly; the
// long tail rolls into 'b2b_other'. The bucketing keeps the
// front-end chart from drowning in a thousand corporate domains.
//
// Surfaces:
//
//   GET /api/v1/isp-breakdown                 ?days=30
//   GET /api/v1/isp-breakdown/by-campaign/{id}  campaign-scoped

package isp_breakdown

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

// Bucket is one ISP-grouped row.
type Bucket struct {
	ISP           string  `json:"isp"`
	Subscribers   int64   `json:"subscribers"`
	Sent          int64   `json:"sent"`
	Opens         int64   `json:"opens"`
	Clicks        int64   `json:"clicks"`
	Bounces       int64   `json:"bounces"`
	Complaints    int64   `json:"complaints"`
	OpenRate      float64 `json:"open_rate"`
	ClickRate     float64 `json:"click_rate"`
	BounceRate    float64 `json:"bounce_rate"`
	ComplaintRate float64 `json:"complaint_rate"`
}

// MountRoutes registers the read endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/isp-breakdown", d.Tenant)
	r.With(read).Get("/api/v1/isp-breakdown/by-campaign/{id}", d.Campaign)
}

// Tenant GET /api/v1/isp-breakdown?days=30.
//
// Rolls up every subscriber_events row in the window, bucketing
// by recipient ISP. "Sent" isn't directly stored on
// subscriber_events, so we approximate it as the count of
// subscribers in the ISP bucket that received any event in the
// window — a reasonable proxy that avoids needing a separate
// campaign_recipients join here.
func (d *Deps) Tenant(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant")
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

	rows, err := tx.Query(r.Context(), buildSQL(false), t.ID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days,
		"buckets":     scanBuckets(rows),
	})
}

// Campaign GET /api/v1/isp-breakdown/by-campaign/{id}.
func (d *Deps) Campaign(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign", "campaign id is required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), buildSQL(true), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	writeJSON(w, http.StatusOK, map[string]any{
		"campaign_id": id,
		"buckets":     scanBuckets(rows),
	})
}

// buildSQL constructs the rollup query. byCampaign=true scopes by
// campaign_id instead of by time window.
func buildSQL(byCampaign bool) string {
	// CASE expression normalizes the host part of the email to one
	// of the well-known ISP buckets. Updates here automatically
	// reflow both the tenant + per-campaign endpoint.
	const ispCase = `
CASE lower(split_part(subscriber_email::text, '@', 2))
  WHEN 'gmail.com'      THEN 'gmail'
  WHEN 'googlemail.com' THEN 'gmail'
  WHEN 'outlook.com'    THEN 'outlook'
  WHEN 'hotmail.com'    THEN 'outlook'
  WHEN 'live.com'       THEN 'outlook'
  WHEN 'msn.com'        THEN 'outlook'
  WHEN 'yahoo.com'      THEN 'yahoo'
  WHEN 'ymail.com'      THEN 'yahoo'
  WHEN 'icloud.com'     THEN 'apple'
  WHEN 'me.com'         THEN 'apple'
  WHEN 'mac.com'        THEN 'apple'
  WHEN 'proton.me'      THEN 'proton'
  WHEN 'protonmail.com' THEN 'proton'
  WHEN 'aol.com'        THEN 'aol'
  WHEN 'fastmail.com'   THEN 'fastmail'
  WHEN 'zoho.com'       THEN 'zoho'
  ELSE 'b2b_other'
END`
	predicate := "tenant_id = $1::uuid AND at >= $2"
	if byCampaign {
		predicate = "tenant_id = $1::uuid AND campaign_id = $2::uuid"
	}
	// Unique-counts: ESP convention is "open rate = unique openers /
	// recipients", not "total opens / recipients". A subscriber that
	// opens 5x counts once. Same for clicks/bounces/complaints.
	return `
SELECT ` + ispCase + ` AS isp,
       count(DISTINCT subscriber_email) AS sent_approx,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')      AS opens,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked')     AS clicks,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'bounced')     AS bounces,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'complained')  AS complaints
  FROM subscriber_events
 WHERE ` + predicate + `
 GROUP BY 1
 ORDER BY sent_approx DESC
 LIMIT 100`
}

func scanBuckets(rows interface {
	Next() bool
	Scan(...any) error
	Close()
}) []Bucket {
	out := []Bucket{}
	for rows.Next() {
		var b Bucket
		if err := rows.Scan(&b.ISP, &b.Sent, &b.Opens, &b.Clicks,
			&b.Bounces, &b.Complaints); err != nil {
			continue
		}
		b.Subscribers = b.Sent
		den := float64(b.Sent)
		if den == 0 {
			den = 1
		}
		b.OpenRate = float64(b.Opens) / den
		b.ClickRate = float64(b.Clicks) / den
		b.BounceRate = float64(b.Bounces) / den
		b.ComplaintRate = float64(b.Complaints) / den
		out = append(out, b)
	}
	return out
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
