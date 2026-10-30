// SPDX-License-Identifier: AGPL-3.0-only
//
// Package cohorts builds a retention/engagement cohort matrix from
// subscribers + subscriber_events.
//
//   GET /api/v1/cohorts?period=week&windows=12
//
// Returns a matrix:
//
//   rows = signup cohort (week of subscribers.created_at), oldest
//           first.
//   cols = weeks-since-signup (0 = same week as signup, 1 = next
//           week, ...).
//   value = number of subscribers in this cohort who had ANY
//           engagement event (opened / clicked / submitted) in
//           the given column's week.
//
// V1 supports period={week,month} + windows=1..52. The query is
// pure SQL: one CTE to bucket subscribers into cohorts, another to
// bucket events, then a pivot via FILTER aggregates.
//
// The frontend renders this as the canonical "Mixpanel-style"
// retention heatmap.

package cohorts

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the handler.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers GET /api/v1/cohorts. Read-reports scope —
// not destructive; not sensitive beyond the tenant's own data.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/cohorts", d.Cohorts)
}

// CohortRow is one cohort's retention vector.
type CohortRow struct {
	// CohortStart is the first day of the cohort bucket (week or
	// month).
	CohortStart string `json:"cohort_start"`
	// Size is the absolute size of the cohort at acquisition time.
	Size int64 `json:"size"`
	// Engagements is the per-column engaged count. Length =
	// windows + 1 (column 0 is "same period as signup").
	Engagements []int64 `json:"engagements"`
	// Pcts is the same vector normalised to size (0..100). When
	// Size=0 every entry is 0.
	Pcts []float64 `json:"pcts"`
}

// Response is the wire shape.
type Response struct {
	Period  string      `json:"period"`
	Windows int         `json:"windows"`
	Cohorts []CohortRow `json:"cohorts"`
	// AveragePcts collapses the cohort matrix into the
	// "across-all-cohorts average retention curve". Common
	// summary view on top of the heatmap.
	AveragePcts []float64 `json:"average_pcts"`
}

// Cohorts GET /api/v1/cohorts.
func (d *Deps) Cohorts(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	period := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("period")))
	if period == "" {
		period = "week"
	}
	if period != "week" && period != "month" {
		writeErr(w, http.StatusBadRequest, "invalid_period",
			"period must be 'week' or 'month'")
		return
	}
	windows := 12
	if v := r.URL.Query().Get("windows"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 52 {
			windows = n
		}
	}

	resp, err := d.compute(r, t.ID, period, windows)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// compute runs the SQL + builds the wire shape.
//
// The query uses date_trunc + age math entirely in Postgres so the
// result set is small (cohorts × 1 row) — Go just shapes the
// response.
func (d *Deps) compute(r *http.Request, tenantID, period string, windows int) (*Response, error) {
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Build the time-bucket expressions per period. We use date_trunc
	// which returns timestamptz; cast to date for stable bucket keys.
	bucket := "week"
	intervalExpr := "INTERVAL '1 week'"
	if period == "month" {
		bucket = "month"
		intervalExpr = "INTERVAL '1 month'"
	}

	// Cohorts: subscribers grouped by date_trunc(created_at).
	// Limit to the last (windows + 6) periods so we don't return a
	// 5-year-old empty matrix.
	cohortLimit := windows + 6
	cohortQuery := `
WITH cohorts AS (
  SELECT date_trunc($2, s.created_at)::date AS cohort_start,
         COUNT(*) AS size
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND s.created_at > now() - ($3::int * ` + intervalExpr + `)
   GROUP BY 1
)
SELECT cohort_start, size
  FROM cohorts
 ORDER BY cohort_start ASC`
	cohortRows, err := tx.Query(r.Context(), cohortQuery, tenantID, bucket, cohortLimit)
	if err != nil {
		return nil, err
	}
	defer cohortRows.Close()
	type cohort struct {
		start string
		size  int64
	}
	cohorts := []cohort{}
	for cohortRows.Next() {
		var c cohort
		if err := cohortRows.Scan(&c.start, &c.size); err != nil {
			return nil, err
		}
		cohorts = append(cohorts, c)
	}
	if err := cohortRows.Err(); err != nil {
		return nil, err
	}
	cohortRows.Close()

	// Engagements per (cohort, window-offset). For each event in
	// the last (windows*period) since signup, compute the period
	// offset = (event_period - signup_period).
	engagementQuery := `
SELECT date_trunc($2, s.created_at)::date AS cohort_start,
       FLOOR(EXTRACT(EPOCH FROM date_trunc($2, e.at) - date_trunc($2, s.created_at))
             / EXTRACT(EPOCH FROM ` + intervalExpr + `))::int AS offset_periods,
       COUNT(DISTINCT s.id) AS engaged
  FROM subscribers s
  JOIN subscriber_events e
    ON e.subscriber_email = s.email
   AND e.tenant_id = s.tenant_id
 WHERE s.tenant_id = $1::uuid
   AND e.event_type IN ('opened','clicked','form_submit')
   AND e.at >= s.created_at
   AND e.at < s.created_at + (($3::int + 1) * ` + intervalExpr + `)
 GROUP BY 1, 2`
	engRows, err := tx.Query(r.Context(), engagementQuery, tenantID, bucket, windows)
	if err != nil {
		return nil, err
	}
	defer engRows.Close()
	engaged := map[string]map[int]int64{}
	for engRows.Next() {
		var ck string
		var offset int
		var count int64
		if err := engRows.Scan(&ck, &offset, &count); err != nil {
			return nil, err
		}
		if engaged[ck] == nil {
			engaged[ck] = make(map[int]int64)
		}
		engaged[ck][offset] = count
	}
	if err := engRows.Err(); err != nil {
		return nil, err
	}

	// Build the response matrix.
	resp := &Response{
		Period:      period,
		Windows:     windows,
		Cohorts:     []CohortRow{},
		AveragePcts: make([]float64, windows+1),
	}
	cohortPctSum := make([]float64, windows+1)
	cohortPctCount := make([]int, windows+1)
	for _, c := range cohorts {
		row := CohortRow{
			CohortStart: c.start,
			Size:        c.size,
			Engagements: make([]int64, windows+1),
			Pcts:        make([]float64, windows+1),
		}
		for off := 0; off <= windows; off++ {
			n := engaged[c.start][off]
			row.Engagements[off] = n
			if c.size > 0 {
				row.Pcts[off] = float64(n) / float64(c.size) * 100.0
				cohortPctSum[off] += row.Pcts[off]
				cohortPctCount[off]++
			}
		}
		resp.Cohorts = append(resp.Cohorts, row)
	}
	for off := 0; off <= windows; off++ {
		if cohortPctCount[off] > 0 {
			resp.AveragePcts[off] = cohortPctSum[off] / float64(cohortPctCount[off])
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	return resp, nil
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
