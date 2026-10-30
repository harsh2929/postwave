// SPDX-License-Identifier: AGPL-3.0-only
//
// Package from_name_picker analyzes the historical engagement of
// each from_name a tenant has shipped from and surfaces the
// best performers as suggestions for the next campaign.
//
// The from-name matters more than most operators realize: studies
// consistently put it as the #1 driver of open rate (ahead of
// subject line). "Jane from Acme" outperforms "Acme Marketing" by
// 30-50% across many lists. But the right answer is tenant-specific
// — one tenant's list responds to a personal name, another to a
// brand voice — so we don't ship opinionated defaults; we surface
// the data the operator's own list produced.
//
// Surfaces:
//
//   GET /api/v1/from-name-picker?days=180&min_campaigns=2
//
// Per row:
//   * from_name
//   * campaigns_using
//   * total_recipients
//   * open_rate
//   * click_rate
//   * complaint_rate
//   * confidence    higher when more campaigns + more recipients
//   * rank          1 = best in tenant's history
//
// We require min_campaigns (default 2) to avoid surfacing the
// once-used novelty from-names with an artificially high open rate
// from a tiny sample.

package from_name_picker

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"sort"
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

// Row is one from-name's rollup.
type Row struct {
	FromName        string  `json:"from_name"`
	CampaignsUsing  int     `json:"campaigns_using"`
	TotalRecipients int64   `json:"total_recipients"`
	Opens           int64   `json:"opens"`
	Clicks          int64   `json:"clicks"`
	Complaints      int64   `json:"complaints"`
	OpenRate        float64 `json:"open_rate"`
	ClickRate       float64 `json:"click_rate"`
	ComplaintRate   float64 `json:"complaint_rate"`
	Confidence      float64 `json:"confidence"`
	Rank            int     `json:"rank"`
}

// MountRoutes registers the read endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/from-name-picker", d.List)
}

// List GET /api/v1/from-name-picker?days=180&min_campaigns=2.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := 180
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 7 && n <= 730 {
			days = n
		}
	}
	minCampaigns := 2
	if v := r.URL.Query().Get("min_campaigns"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 100 {
			minCampaigns = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// CTE: campaigns that sent in the window (must have a from_name
	// AND have generated subscriber_events), with their aggregated
	// engagement counts.
	rows, err := tx.Query(r.Context(), `
WITH window_campaigns AS (
  SELECT c.id, c.from_name
    FROM campaigns c
   WHERE c.tenant_id = $1::uuid
     AND c.from_name IS NOT NULL AND c.from_name <> ''
     AND c.sent_at IS NOT NULL AND c.sent_at >= $2
), aggregated AS (
  SELECT c.from_name,
         COUNT(DISTINCT c.id)                                          AS campaigns_using,
         COUNT(DISTINCT (c.id, e.subscriber_email))
           FILTER (WHERE e.subscriber_email IS NOT NULL)               AS recipients,
         COUNT(DISTINCT (c.id, e.subscriber_email))
           FILTER (WHERE e.event_type = 'opened'
                     AND e.subscriber_email IS NOT NULL)               AS opens,
         COUNT(DISTINCT (c.id, e.subscriber_email))
           FILTER (WHERE e.event_type = 'clicked'
                     AND e.subscriber_email IS NOT NULL)               AS clicks,
         COUNT(DISTINCT (c.id, e.subscriber_email))
           FILTER (WHERE e.event_type = 'complained'
                     AND e.subscriber_email IS NOT NULL)               AS complaints
    FROM window_campaigns c
    LEFT JOIN subscriber_events e
      ON e.tenant_id = $1::uuid AND e.campaign_id = c.id
   GROUP BY c.from_name
)
SELECT from_name, campaigns_using, recipients, opens, clicks, complaints
  FROM aggregated
 WHERE campaigns_using >= $3
 ORDER BY recipients DESC`, t.ID, since, minCampaigns)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := []Row{}
	for rows.Next() {
		var rrw Row
		if err := rows.Scan(&rrw.FromName, &rrw.CampaignsUsing, &rrw.TotalRecipients,
			&rrw.Opens, &rrw.Clicks, &rrw.Complaints); err != nil {
			continue
		}
		den := float64(rrw.TotalRecipients)
		if den == 0 {
			den = 1
		}
		rrw.OpenRate = float64(rrw.Opens) / den
		rrw.ClickRate = float64(rrw.Clicks) / den
		rrw.ComplaintRate = float64(rrw.Complaints) / den
		rrw.Confidence = confidence(rrw.CampaignsUsing, rrw.TotalRecipients)
		out = append(out, rrw)
	}

	// Rank by a composite score = open_rate * confidence -
	// complaint_rate * penalty. The confidence multiplier prevents
	// a one-campaign 100% open rate from beating a six-campaign
	// 35% open rate.
	rank(out)

	writeJSON(w, http.StatusOK, map[string]any{
		"window_days":   days,
		"min_campaigns": minCampaigns,
		"from_names":    out,
		"count":         len(out),
	})
}

// confidence is a 0..1 score: more campaigns + more recipients =
// higher. Saturates around 10 campaigns / 100k recipients.
func confidence(campaigns int, recipients int64) float64 {
	c := math.Min(float64(campaigns)/10.0, 1.0)
	r := math.Min(float64(recipients)/100000.0, 1.0)
	// Geometric mean — both signals must be present for high
	// confidence. (One huge campaign isn't enough; ten tiny ones
	// aren't either.)
	return math.Sqrt(c * r)
}

func rank(rows []Row) {
	score := func(r Row) float64 {
		// Open rate weighted by confidence, with a complaint penalty.
		return r.OpenRate*r.Confidence - r.ComplaintRate*50
	}
	// The old implementation assigned Rank through an index side table but
	// left `rows` in recipient-count order. Both clients slice the first five,
	// so a lower performer could be shown while rank 1 sat below the fold.
	// Stable ties preserve the query's recipient-count ordering.
	sort.SliceStable(rows, func(i, j int) bool {
		return score(rows[i]) > score(rows[j])
	})
	for i := range rows {
		rows[i].Rank = i + 1
	}
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

var _ = errors.New
