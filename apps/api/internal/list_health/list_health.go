// SPDX-License-Identifier: AGPL-3.0-only
//
// Package list_health computes a composite 0-100 "list quality"
// score over a tenant's subscriber pool, optionally filtered by a
// tag (the tag-as-list pattern Moosewave uses since the canonical
// list registry lives in Listmonk and is not joinable from here).
//
// Inputs the score blends, all measured over a sliding window
// (default 90 days):
//
//   bounce_rate           bounces       / active_subscribers
//   complaint_rate        complaints    / active_subscribers
//   unsubscribe_rate      unsubscribes  / active_subscribers
//   engagement_rate       opens|clicks distinct subscribers / active_subscribers
//   suppression_rate      blocklisted   / total
//
// The score starts at 100 and is decremented against well-known
// ESP-industry thresholds (Postmark + SendGrid guidelines). Grade
// labels: A 90-100 / B 75-89 / C 60-74 / D 40-59 / F <40.
//
// Surface:
//
//   GET /api/v1/list-health?tag=<optional>&window_days=90

package list_health

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"

	"github.com/go-chi/chi/v5"
)

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// tenant_id+request_id+err context without leaking err.Error() to
	// the client. nil-safe at the httperror call site.
	Logger *slog.Logger
}

// Score is the response shape.
type Score struct {
	Tag                string   `json:"tag,omitempty"`
	WindowDays         int      `json:"window_days"`
	TotalSubscribers   int64    `json:"total_subscribers"`
	ActiveSubscribers  int64    `json:"active_subscribers"`
	EngagedSubscribers int64    `json:"engaged_subscribers"`
	BlocklistedCount   int64    `json:"blocklisted_count"`
	Bounces            int64    `json:"bounces"`
	Complaints         int64    `json:"complaints"`
	Unsubscribes       int64    `json:"unsubscribes"`
	BounceRate         float64  `json:"bounce_rate"`
	ComplaintRate      float64  `json:"complaint_rate"`
	UnsubscribeRate    float64  `json:"unsubscribe_rate"`
	EngagementRate     float64  `json:"engagement_rate"`
	SuppressionRate    float64  `json:"suppression_rate"`
	Score              int      `json:"score"`
	Grade              string   `json:"grade"`
	Notes              []string `json:"notes"`
}

// MountRoutes registers the read-reports endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/list-health", d.Get)
}

// Get GET /api/v1/list-health?tag=&window_days=.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	tag := strings.TrimSpace(q.Get("tag"))
	windowDays := clampWindowDays(q.Get("window_days"))
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	score, err := compute(r.Context(), tx, t.ID, tag, since, windowDays)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, score)
}

// compute does the actual scoring. Single round-trip CTE over
// subscribers + subscriber_events.
func compute(ctx context.Context, tx pgx.Tx, tenantID, tag string, since time.Time, windowDays int) (Score, error) {
	out := Score{Tag: tag, WindowDays: windowDays, Notes: []string{}}

	// Build the subscriber predicate. The tags column is a text[]
	// so we use the array containment operator @> for an indexed
	// match (subscribers_tags_gin).
	subWhere := "tenant_id = $1::uuid"
	args := []any{tenantID}
	if tag != "" {
		subWhere += " AND tags @> ARRAY[$2]::text[]"
		args = append(args, tag)
	}

	// Subscriber-level counts.
	type subRow struct {
		Total       int64
		Active      int64
		Blocklisted int64
	}
	var sr subRow
	err := tx.QueryRow(ctx, `
SELECT count(*) AS total,
       count(*) FILTER (WHERE status = 'enabled') AS active,
       count(*) FILTER (WHERE status = 'blocklisted') AS blocklisted
  FROM subscribers
 WHERE `+subWhere, args...).Scan(&sr.Total, &sr.Active, &sr.Blocklisted)
	if err != nil {
		return out, err
	}
	out.TotalSubscribers = sr.Total
	out.ActiveSubscribers = sr.Active
	out.BlocklistedCount = sr.Blocklisted

	// Engagement and event counts over the window. We join by
	// subscriber_email rather than subscriber_id because
	// subscriber_events stores citext email; this is consistent
	// with the rest of the codebase.
	//
	// When a tag filter is in play we restrict by joining to
	// subscribers; otherwise we go straight against
	// subscriber_events for speed.
	emailFilter := ""
	evArgs := []any{tenantID, since}
	if tag != "" {
		emailFilter = ` AND subscriber_email IN (
			SELECT email FROM subscribers
			WHERE tenant_id = $1::uuid AND tags @> ARRAY[$3]::text[]
		)`
		evArgs = append(evArgs, tag)
	}

	err = tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE event_type = 'bounced')      AS bounces,
  count(*) FILTER (WHERE event_type = 'complained')   AS complaints,
  count(*) FILTER (WHERE event_type = 'unsubscribed') AS unsubs,
  count(DISTINCT subscriber_email) FILTER (
    WHERE event_type IN ('opened','clicked')
  ) AS engaged
FROM subscriber_events
WHERE tenant_id = $1::uuid
  AND at >= $2`+emailFilter, evArgs...).Scan(
		&out.Bounces, &out.Complaints, &out.Unsubscribes, &out.EngagedSubscribers)
	if err != nil {
		return out, err
	}

	denomActive := float64(out.ActiveSubscribers)
	if denomActive < 1 {
		denomActive = 1
	}
	denomTotal := float64(out.TotalSubscribers)
	if denomTotal < 1 {
		denomTotal = 1
	}

	out.BounceRate = float64(out.Bounces) / denomActive
	out.ComplaintRate = float64(out.Complaints) / denomActive
	out.UnsubscribeRate = float64(out.Unsubscribes) / denomActive
	out.EngagementRate = float64(out.EngagedSubscribers) / denomActive
	out.SuppressionRate = float64(out.BlocklistedCount) / denomTotal

	out.Score, out.Grade, out.Notes = scoreAndGrade(out)
	return out, nil
}

// scoreAndGrade applies the ESP-industry thresholds. Order of
// penalties is deliberately additive — each metric is independent
// of the others so a list with one extreme issue and one mild
// issue surfaces both.
func scoreAndGrade(s Score) (int, string, []string) {
	score := 100.0
	notes := []string{}

	// Bounce rate. Above 2% = serious problem.
	if s.BounceRate > 0.005 {
		extraPP := (s.BounceRate - 0.005) * 100
		penalty := extraPP * 2.0
		score -= penalty
		notes = append(notes, formatNote("bounce rate %.2f%% over 0.5%% threshold", s.BounceRate*100))
	}
	// Complaint rate. The classic 0.1% inbox-provider redline.
	if s.ComplaintRate > 0.0005 {
		extraPP := (s.ComplaintRate - 0.0005) * 100
		penalty := extraPP * 50.0
		score -= penalty
		notes = append(notes, formatNote("complaint rate %.3f%% over 0.05%% threshold", s.ComplaintRate*100))
	}
	// Engagement rate (cold list penalty). Anything under 15% is a
	// real concern.
	if s.EngagementRate < 0.15 && s.ActiveSubscribers > 100 {
		gapPP := (0.15 - s.EngagementRate) * 100
		penalty := gapPP * 0.5
		score -= penalty
		notes = append(notes, formatNote("engagement %.1f%% below 15%% — consider sunset", s.EngagementRate*100))
	}
	// Unsub rate. >2% is a "subscribers don't want this" signal.
	if s.UnsubscribeRate > 0.02 {
		extraPP := (s.UnsubscribeRate - 0.02) * 100
		penalty := extraPP * 1.5
		score -= penalty
		notes = append(notes, formatNote("unsub rate %.2f%% above 2%% threshold", s.UnsubscribeRate*100))
	}
	// Suppression bloat. >5% blocklisted = stale list.
	if s.SuppressionRate > 0.05 {
		extraPP := (s.SuppressionRate - 0.05) * 100
		penalty := extraPP * 0.5
		score -= penalty
		notes = append(notes, formatNote("%.1f%% of subscribers are blocklisted", s.SuppressionRate*100))
	}

	if score < 0 {
		score = 0
	}
	rounded := int(score + 0.5)
	grade := "F"
	switch {
	case rounded >= 90:
		grade = "A"
	case rounded >= 75:
		grade = "B"
	case rounded >= 60:
		grade = "C"
	case rounded >= 40:
		grade = "D"
	}
	if len(notes) == 0 {
		notes = append(notes, "all health indicators within ESP-industry safe thresholds")
	}
	return rounded, grade, notes
}

func formatNote(f string, args ...any) string {
	return strings.TrimSpace(fmt.Sprintf(f, args...))
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

// keep errors imported for future typed errors.
var _ = errors.New
var _ = context.Background

// chi-param helper kept available even though we don't use it
// today; future per-tag-by-name lookup might.
var _ = chi.URLParam

// clampWindowDays parses the ?window_days= query value, falling back
// to the 90-day default on empty / unparseable input and clamping to
// the supported range [7, 365]. Whitespace is tolerated.
func clampWindowDays(raw string) int {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 90
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 90
	}
	if n < 7 {
		return 7
	}
	if n > 365 {
		return 365
	}
	return n
}
