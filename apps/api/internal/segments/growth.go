// SPDX-License-Identifier: AGPL-3.0-only
//
// growth.go — GET /api/v1/segments/{id}/growth?days=90
// (feat/full-surface-wiring task 4).
//
// Reads the daily count series the snapshot worker
// (snapshot_worker.go) writes into segment_size_history (migration
// 0392). This is the chart-ready companion to the older
// /size-history endpoint: where size-history degrades to a live
// point, /growth additionally computes the net delta over the window
// so the dashboard can render "+312 (+4.1%) over 90d" without
// client-side math.

package segments

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GrowthPoint is one daily snapshot on the growth series.
type GrowthPoint struct {
	Date        string    `json:"date"` // YYYY-MM-DD snapshot_date
	EvaluatedAt time.Time `json:"evaluated_at"`
	Count       int       `json:"count"`
}

// GrowthResponse is the wire shape.
type GrowthResponse struct {
	SegmentID string        `json:"segment_id"`
	Days      int           `json:"days"`
	Series    []GrowthPoint `json:"series"`
	// Delta / DeltaPct compare the newest point against the oldest
	// point in the window. Zero-valued when fewer than 2 points.
	Delta    int     `json:"delta"`
	DeltaPct float64 `json:"delta_pct"`
	// Note explains an empty/short series (no snapshots yet).
	Note string `json:"note,omitempty"`
}

// parseGrowthDays accepts a positive integer day count, defaulting to
// 90 and clamping to [1, 365].
func parseGrowthDays(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 90
	}
	n, err := strconv.Atoi(strings.TrimSuffix(strings.ToLower(s), "d"))
	if err != nil || n <= 0 {
		return 90
	}
	if n > 365 {
		return 365
	}
	return n
}

// growthDelta computes (delta, deltaPct) between the first and last
// points of the series. Pure — unit-tested directly.
func growthDelta(series []GrowthPoint) (int, float64) {
	if len(series) < 2 {
		return 0, 0
	}
	first := series[0].Count
	last := series[len(series)-1].Count
	delta := last - first
	if first == 0 {
		return delta, 0
	}
	return delta, float64(delta) / float64(first) * 100
}

// SegmentGrowth GET /api/v1/segments/{id}/growth?days=90.
func (d *Deps) SegmentGrowth(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "segment id required")
		return
	}
	days := parseGrowthDays(r.URL.Query().Get("days"))

	// 404 unknown segments rather than returning an empty series for
	// a typo'd id.
	if _, err := d.Repo.Get(r.Context(), t.ID, id); err != nil {
		if err == ErrNotFound {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	out := GrowthResponse{SegmentID: id, Days: days, Series: []GrowthPoint{}}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT snapshot_date::text, evaluated_at, count
  FROM segment_size_history
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid
   AND snapshot_date >= CURRENT_DATE - $3::int
 ORDER BY snapshot_date ASC`, t.ID, id, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	for rows.Next() {
		var p GrowthPoint
		if err := rows.Scan(&p.Date, &p.EvaluatedAt, &p.Count); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		out.Series = append(out.Series, p)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out.Delta, out.DeltaPct = growthDelta(out.Series)
	if len(out.Series) == 0 {
		out.Note = "no snapshots yet; the daily snapshot worker populates this series"
	}
	writeJSON(w, http.StatusOK, out)
}
