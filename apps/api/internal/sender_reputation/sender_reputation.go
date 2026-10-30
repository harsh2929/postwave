// SPDX-License-Identifier: AGPL-3.0-only
//
// Package sender_reputation aggregates deliverability signals into
// a per-domain + per-IP-pool reputation dashboard with historical
// trend.
//
// Sources joined:
//   * dmarc_reports — DMARC aggregate pass/fail rates per domain
//   * blocklist_observations — RBL listings per IP / domain
//   * subscriber_events — bounce / complaint rates per sending domain
//
// V1 surfaces:
//
//   GET /api/v1/sender-reputation                     dashboard JSON
//   GET /api/v1/sender-reputation/{domain}/history    14-day trend
//
// Reputation score (0..100):
//   100 = perfect (no blocklist hits, DMARC pass > 95%,
//          bounce < 1%, complaint < 0.1%)
//   0   = on multiple major blocklists OR DMARC pass < 50%
//          OR bounce > 10%
//
// Bucketed so the dashboard can render badges (Excellent / Good /
// Fair / Poor / Critical).

package sender_reputation

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// DomainStat is one domain's current reputation.
type DomainStat struct {
	Domain         string  `json:"domain"`
	Score          int     `json:"score"`
	Grade          string  `json:"grade"` // Excellent | Good | Fair | Poor | Critical
	SendsLast7d    int64   `json:"sends_last_7d"`
	BounceRate     float64 `json:"bounce_rate"`
	ComplaintRate  float64 `json:"complaint_rate"`
	DMARCPassRate  float64 `json:"dmarc_pass_rate"`
	BlocklistHits  int64   `json:"blocklist_hits"`
	LastIncidentAt *string `json:"last_incident_at,omitempty"`
}

// HistoryPoint is one day in the trend chart.
type HistoryPoint struct {
	Day           string  `json:"day"`
	Score         int     `json:"score"`
	Sends         int64   `json:"sends"`
	BounceRate    float64 `json:"bounce_rate"`
	ComplaintRate float64 `json:"complaint_rate"`
}

// Deps wires the handlers.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers the dashboard endpoints. Read-reports
// scope — surface is sensitive but not destructive.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/sender-reputation", d.Dashboard)
	r.With(read).Get("/api/v1/sender-reputation/{domain}/history", d.History)
}

// Dashboard GET /api/v1/sender-reputation.
//
// Returns one DomainStat per FROM-domain the tenant has sent from
// in the last 7 days. Scores are computed inline (no separate
// cache table) — the query bounded at a handful of domains per
// tenant.
func (d *Deps) Dashboard(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Pull bounce/complaint/send aggregates per from-domain over
	// the last 7 days. We derive the domain from subscriber_email
	// fallback when there's no explicit from_domain column on the
	// events table; deployments that have one swap the parse.
	rows, err := tx.Query(r.Context(), `
WITH events AS (
  SELECT
    COALESCE(
      NULLIF(metadata->>'from_domain', ''),
      split_part(metadata->>'from', '@', 2)
    ) AS from_domain,
    event_type,
    at
   FROM subscriber_events
  WHERE tenant_id = $1::uuid
    AND at > now() - INTERVAL '7 days'
),
aggregated AS (
  SELECT from_domain,
         COUNT(*) FILTER (WHERE event_type = 'sent') AS sends,
         COUNT(*) FILTER (WHERE event_type = 'bounced') AS bounces,
         COUNT(*) FILTER (WHERE event_type = 'complained') AS complaints,
         MAX(at) FILTER (WHERE event_type IN ('bounced','complained')) AS last_incident
    FROM events
   WHERE from_domain IS NOT NULL AND from_domain <> ''
   GROUP BY from_domain
)
SELECT from_domain, sends, bounces, complaints, last_incident
  FROM aggregated
 ORDER BY sends DESC
 LIMIT 50`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []DomainStat{}
	for rows.Next() {
		var (
			domain                     string
			sends, bounces, complaints int64
			lastIncident               *time.Time
		)
		if err := rows.Scan(&domain, &sends, &bounces, &complaints, &lastIncident); err != nil {
			continue
		}
		stat := DomainStat{Domain: domain, SendsLast7d: sends}
		if sends > 0 {
			stat.BounceRate = float64(bounces) / float64(sends) * 100
			stat.ComplaintRate = float64(complaints) / float64(sends) * 100
		}
		if lastIncident != nil {
			s := lastIncident.UTC().Format(time.RFC3339)
			stat.LastIncidentAt = &s
		}
		// Layer in DMARC + blocklist signals — both are optional
		// (some deployments don't have the DMARC pipeline up yet).
		stat.DMARCPassRate = d.dmarcPassRate(r.Context(), tx, t.ID, domain)
		stat.BlocklistHits = d.blocklistHits(r.Context(), tx, t.ID, domain)
		stat.Score = scoreDomain(stat)
		stat.Grade = gradeForScore(stat.Score)
		out = append(out, stat)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"domains": out})
}

// History GET /api/v1/sender-reputation/{domain}/history — 14-day
// daily trend for one domain.
func (d *Deps) History(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	domain := strings.TrimSpace(chi.URLParam(r, "domain"))
	if domain == "" {
		writeErr(w, http.StatusBadRequest, "missing_domain", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT date_trunc('day', at)::date AS day,
       COUNT(*) FILTER (WHERE event_type = 'sent') AS sends,
       COUNT(*) FILTER (WHERE event_type = 'bounced') AS bounces,
       COUNT(*) FILTER (WHERE event_type = 'complained') AS complaints
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND at > now() - INTERVAL '14 days'
   AND COALESCE(
         NULLIF(metadata->>'from_domain', ''),
         split_part(metadata->>'from', '@', 2)
       ) = $2
 GROUP BY 1
 ORDER BY 1 ASC`, t.ID, domain)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []HistoryPoint{}
	for rows.Next() {
		var (
			day                        string
			sends, bounces, complaints int64
		)
		if err := rows.Scan(&day, &sends, &bounces, &complaints); err != nil {
			continue
		}
		hp := HistoryPoint{Day: day, Sends: sends}
		if sends > 0 {
			hp.BounceRate = float64(bounces) / float64(sends) * 100
			hp.ComplaintRate = float64(complaints) / float64(sends) * 100
		}
		// Day-level score uses the same scoring func with synthesised
		// DomainStat values.
		hp.Score = scoreDomain(DomainStat{
			SendsLast7d:   sends,
			BounceRate:    hp.BounceRate,
			ComplaintRate: hp.ComplaintRate,
			DMARCPassRate: 100, // unknown at day grain — assume pass
			BlocklistHits: 0,
		})
		out = append(out, hp)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"domain": domain,
		"days":   out,
	})
}

// dmarcPassRate reads the most recent DMARC aggregate-report pct
// for the domain. Returns 100 (neutral) when there's no data so a
// brand-new domain doesn't score 0 just because nobody's reported
// on it yet.
func (d *Deps) dmarcPassRate(ctx context.Context, tx pgx.Tx, tenantID, domain string) float64 {
	// A message passes DMARC if it is ALIGNED on DKIM or SPF. The
	// dkim_result/spf_result columns hold the policy_evaluated (aligned)
	// results (see D10#2). Weight by message count over the 7d window.
	//
	// This used to take `tx interface{}` and do a `tx.(queryable)` assertion
	// that could never succeed (pgx.Tx.QueryRow returns pgx.Row, not the
	// anonymous interface), so it always returned the hardcoded 100 without
	// querying — and even reached for a dead `dmarc_reports` table with
	// non-existent columns (D10#4).
	var pct float64
	err := tx.QueryRow(ctx, `
SELECT COALESCE(
    100.0 * SUM(rec.count) FILTER (
      WHERE LOWER(rec.dkim_result) = 'pass' OR LOWER(rec.spf_result) = 'pass')
    / NULLIF(SUM(rec.count), 0),
  100)
  FROM dmarc_aggregate_records rec
  JOIN dmarc_aggregate_reports rep ON rep.id = rec.report_id
 WHERE rep.tenant_id = $1::uuid
   AND rep.domain = $2
   AND rep.date_range_end > now() - INTERVAL '7 days'`, tenantID, domain).Scan(&pct)
	if err != nil {
		return 100
	}
	return pct
}

// blocklistHits returns the count of currently-listed blocklist
// observations involving this domain in the last 24 hours.
func (d *Deps) blocklistHits(ctx context.Context, tx pgx.Tx, tenantID, domain string) int64 {
	// Count subjects whose LATEST observation (per subject_type/subject/
	// zone) in the last 24h is listed=true — mirroring the blocklist
	// column model the deliverability hub uses. The old query used
	// non-existent `status`/`observed_at` columns behind a type assertion
	// that never ran, so it always returned 0 (D10#4).
	var n int64
	err := tx.QueryRow(ctx, `
WITH latest AS (
  SELECT DISTINCT ON (subject_type, subject, zone) listed
    FROM blocklist_observations
   WHERE tenant_id = $1::uuid
     AND subject = $2
     AND checked_at > now() - INTERVAL '24 hours'
   ORDER BY subject_type, subject, zone, checked_at DESC
)
SELECT COUNT(*) FROM latest WHERE listed = true`, tenantID, domain).Scan(&n)
	if err != nil {
		return 0
	}
	return n
}

// scoreDomain computes the 0..100 reputation score from the four
// inputs. Calibration:
//
//	bounce_rate > 5%        → -30
//	bounce_rate > 2%        → -15
//	bounce_rate > 1%        → -5
//	complaint_rate > 0.5%   → -40
//	complaint_rate > 0.1%   → -20
//	blocklist_hits > 0      → -25
//	dmarc_pass_rate < 50%   → -30
//	dmarc_pass_rate < 90%   → -10
//
// Floor at 0.
func scoreDomain(s DomainStat) int {
	score := 100
	switch {
	case s.BounceRate > 5:
		score -= 30
	case s.BounceRate > 2:
		score -= 15
	case s.BounceRate > 1:
		score -= 5
	}
	switch {
	case s.ComplaintRate > 0.5:
		score -= 40
	case s.ComplaintRate > 0.1:
		score -= 20
	}
	if s.BlocklistHits > 0 {
		score -= 25
	}
	switch {
	case s.DMARCPassRate < 50:
		score -= 30
	case s.DMARCPassRate < 90:
		score -= 10
	}
	if score < 0 {
		score = 0
	}
	return score
}

// gradeForScore maps the numeric score to a badge label.
func gradeForScore(score int) string {
	switch {
	case score >= 90:
		return "Excellent"
	case score >= 75:
		return "Good"
	case score >= 60:
		return "Fair"
	case score >= 40:
		return "Poor"
	}
	return "Critical"
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep errors imported for future typed-error sentinels.
var _ = errors.New
