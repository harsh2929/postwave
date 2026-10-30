// SPDX-License-Identifier: AGPL-3.0-only
//
// growth_report.go — SUB-031 Segment growth report.
//
// The older /growth endpoint (growth.go) reads segment_size_history and
// computes a single net delta over the window. This report endpoint goes
// further: it correlates the daily count series (segment_size_history,
// migration 0392) with the per-member entrant/leaver log
// (segment_membership_log, migration 0411) to produce one row per day
// carrying both the running size AND the adds/drops that produced it, and
// it surfaces the anomaly events the decay radar already detected
// (segment_decay_events, migration 0412) correlated onto the matching
// snapshot_date.
//
// No new tables: this is a pure read over three existing tables.
//
//   GET /api/v1/segments/{id}/growth/report      -> JSON
//   GET /api/v1/segments/{id}/growth/report.csv  -> CSV download
//
// The day-delta join, the anomaly correlation, and the CSV serialisation
// are pure functions (mergeGrowthReportRows, correlateAnomalies,
// growthReportCSV) so they are table-tested without a live database.

package segments

import (
	"encoding/csv"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GrowthReportPoint is one day on the report: the running membership
// count plus the adds/drops that landed that day (from the membership
// log) and the net delta-vs-prior-day.
type GrowthReportPoint struct {
	Date  string `json:"date"` // YYYY-MM-DD snapshot_date
	Count int    `json:"count"`
	// Adds / Drops are the per-day entrant / leaver counts from
	// segment_membership_log. They are bounded by the worker's
	// per-direction cap (MembershipLogCapPerDirection); CappedAdds /
	// CappedDrops disclose when a day hit that cap so the UI can render
	// "≥1000" honestly rather than implying the log is exhaustive.
	Adds        int  `json:"adds"`
	Drops       int  `json:"drops"`
	CappedAdds  bool `json:"capped_adds,omitempty"`
	CappedDrops bool `json:"capped_drops,omitempty"`
	// Delta is the change in Count from the previous reported day (0 on
	// the first day). Net adds−drops can diverge from Delta when the log
	// was capped or when membership churned without crossing the log.
	Delta int `json:"delta"`
	// AnomalyKind is set when a segment_decay_events row exists for this
	// snapshot_date (size_cliff / zero_match / everyone_match / ...).
	AnomalyKind string `json:"anomaly_kind,omitempty"`
}

// GrowthReportAnomaly is the projection of a correlated decay event,
// surfaced as a top-level list so the chart can render markers without
// re-scanning the point series.
type GrowthReportAnomaly struct {
	Date         string `json:"date"`
	AnomalyKind  string `json:"anomaly_kind"`
	PriorCount   int    `json:"prior_count"`
	NewCount     int    `json:"new_count"`
	LeaverCount  int    `json:"leaver_count"`
	EntrantCount int    `json:"entrant_count"`
}

// GrowthReportResponse is the wire shape of the JSON report.
type GrowthReportResponse struct {
	SegmentID string                `json:"segment_id"`
	Days      int                   `json:"days"`
	Series    []GrowthReportPoint   `json:"series"`
	Anomalies []GrowthReportAnomaly `json:"anomalies"`
	// TotalAdds / TotalDrops sum the per-day figures over the window.
	TotalAdds  int     `json:"total_adds"`
	TotalDrops int     `json:"total_drops"`
	NetDelta   int     `json:"net_delta"`
	NetPct     float64 `json:"net_pct"`
	Note       string  `json:"note,omitempty"`
}

// dailyChurn is the raw per-day entrant/leaver aggregate read from
// segment_membership_log before it is merged onto the count series.
type dailyChurn struct {
	Date  string
	Adds  int
	Drops int
}

// mergeGrowthReportRows folds the count series (one point per day from
// segment_size_history) together with the per-day churn aggregate (from
// segment_membership_log) into the report series. Pure — no DB. Days are
// matched on the YYYY-MM-DD key; churn for a day without a count row is
// dropped (the count series is authoritative for which days appear). The
// per-day Delta is computed against the previous point in the series.
func mergeGrowthReportRows(counts []GrowthPoint, churn []dailyChurn) []GrowthReportPoint {
	byDate := make(map[string]dailyChurn, len(churn))
	for _, c := range churn {
		byDate[c.Date] = c
	}
	out := make([]GrowthReportPoint, 0, len(counts))
	prev := 0
	for i, p := range counts {
		row := GrowthReportPoint{Date: p.Date, Count: p.Count}
		if c, ok := byDate[p.Date]; ok {
			row.Adds = c.Adds
			row.Drops = c.Drops
			row.CappedAdds = c.Adds >= MembershipLogCapPerDirection
			row.CappedDrops = c.Drops >= MembershipLogCapPerDirection
		}
		if i > 0 {
			row.Delta = p.Count - prev
		}
		prev = p.Count
		out = append(out, row)
	}
	return out
}

// correlateAnomaliesImpl stamps AnomalyKind onto matching days and
// returns the anomaly projection list, newest-day-first preserved from
// the events slice ordering. Pure.
func correlateAnomaliesImpl(series []GrowthReportPoint, events []DecayEvent) []GrowthReportAnomaly {
	if len(events) == 0 {
		return []GrowthReportAnomaly{}
	}
	kindByDate := make(map[string]string, len(events))
	for _, ev := range events {
		// First (newest) event for a day wins the stamp.
		if _, seen := kindByDate[ev.SnapshotDate]; !seen {
			kindByDate[ev.SnapshotDate] = ev.AnomalyKind
		}
	}
	for i := range series {
		if k, ok := kindByDate[series[i].Date]; ok {
			series[i].AnomalyKind = k
		}
	}
	out := make([]GrowthReportAnomaly, 0, len(events))
	for _, ev := range events {
		out = append(out, GrowthReportAnomaly{
			Date:         ev.SnapshotDate,
			AnomalyKind:  ev.AnomalyKind,
			PriorCount:   ev.PriorCount,
			NewCount:     ev.NewCount,
			LeaverCount:  ev.LeaverCount,
			EntrantCount: ev.EntrantCount,
		})
	}
	return out
}

// summariseGrowthReport computes the window totals + net delta/pct over
// the report series. Pure.
func summariseGrowthReport(series []GrowthReportPoint) (totalAdds, totalDrops, netDelta int, netPct float64) {
	for _, p := range series {
		totalAdds += p.Adds
		totalDrops += p.Drops
	}
	if len(series) >= 2 {
		first := series[0].Count
		last := series[len(series)-1].Count
		netDelta = last - first
		if first != 0 {
			netPct = float64(netDelta) / float64(first) * 100
		}
	}
	return
}

// growthReportCSV serialises a report to CSV. Pure (writes to an
// io.Writer). Column order matches the JSON point fields plus the
// anomaly_kind correlation so an analyst can pivot the export directly.
func growthReportCSV(w io.Writer, segmentID string, series []GrowthReportPoint) error {
	cw := csv.NewWriter(w)
	if err := cw.Write([]string{
		"segment_id", "date", "count", "adds", "drops",
		"capped_adds", "capped_drops", "delta", "anomaly_kind",
	}); err != nil {
		return err
	}
	for _, p := range series {
		if err := cw.Write([]string{
			segmentID,
			p.Date,
			strconv.Itoa(p.Count),
			strconv.Itoa(p.Adds),
			strconv.Itoa(p.Drops),
			strconv.FormatBool(p.CappedAdds),
			strconv.FormatBool(p.CappedDrops),
			strconv.Itoa(p.Delta),
			p.AnomalyKind,
		}); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

// buildGrowthReport runs the three reads (counts, churn, decay events)
// under one tenant-scoped tx, then assembles the report with the pure
// helpers. Reused by both the JSON and CSV handlers.
func (d *Deps) buildGrowthReport(r *http.Request, tenantID, segmentID string, days int) (*GrowthReportResponse, error) {
	out := &GrowthReportResponse{
		SegmentID: segmentID,
		Days:      days,
		Series:    []GrowthReportPoint{},
		Anomalies: []GrowthReportAnomaly{},
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// 1. Daily count series (authoritative for which days appear).
	counts := []GrowthPoint{}
	crows, err := tx.Query(r.Context(), `
SELECT snapshot_date::text, evaluated_at, count
  FROM segment_size_history
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid
   AND snapshot_date >= CURRENT_DATE - $3::int
 ORDER BY snapshot_date ASC`, tenantID, segmentID, days)
	if err != nil {
		return nil, err
	}
	for crows.Next() {
		var p GrowthPoint
		if scanErr := crows.Scan(&p.Date, &p.EvaluatedAt, &p.Count); scanErr != nil {
			crows.Close()
			return nil, scanErr
		}
		counts = append(counts, p)
	}
	crows.Close()
	if err := crows.Err(); err != nil {
		return nil, err
	}

	// 2. Per-day entrant/leaver aggregate from the membership log.
	churn := []dailyChurn{}
	mrows, err := tx.Query(r.Context(), `
SELECT snapshot_date::text,
       count(*) FILTER (WHERE direction = 'entered')::int AS adds,
       count(*) FILTER (WHERE direction = 'left')::int    AS drops
  FROM segment_membership_log
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid
   AND snapshot_date >= CURRENT_DATE - $3::int
 GROUP BY snapshot_date`, tenantID, segmentID, days)
	if err != nil {
		return nil, err
	}
	for mrows.Next() {
		var c dailyChurn
		if scanErr := mrows.Scan(&c.Date, &c.Adds, &c.Drops); scanErr != nil {
			mrows.Close()
			return nil, scanErr
		}
		churn = append(churn, c)
	}
	mrows.Close()
	if err := mrows.Err(); err != nil {
		return nil, err
	}

	// 3. Anomaly events within the window (newest-first).
	events := []DecayEvent{}
	erows, err := tx.Query(r.Context(), `
SELECT to_char(snapshot_date, 'YYYY-MM-DD'), anomaly_kind,
       prior_count, new_count, leaver_count, entrant_count
  FROM segment_decay_events
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid
   AND snapshot_date >= CURRENT_DATE - $3::int
 ORDER BY snapshot_date DESC, created_at DESC`, tenantID, segmentID, days)
	if err != nil {
		return nil, err
	}
	for erows.Next() {
		var ev DecayEvent
		if scanErr := erows.Scan(&ev.SnapshotDate, &ev.AnomalyKind,
			&ev.PriorCount, &ev.NewCount, &ev.LeaverCount, &ev.EntrantCount); scanErr != nil {
			erows.Close()
			return nil, scanErr
		}
		events = append(events, ev)
	}
	erows.Close()
	if err := erows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return nil, err
	}

	out.Series = mergeGrowthReportRows(counts, churn)
	out.Anomalies = correlateAnomaliesImpl(out.Series, events)
	out.TotalAdds, out.TotalDrops, out.NetDelta, out.NetPct = summariseGrowthReport(out.Series)
	if len(out.Series) == 0 {
		out.Note = "no snapshots yet; the daily snapshot worker populates this report"
	}
	return out, nil
}

// SegmentGrowthReport GET /api/v1/segments/{id}/growth/report?days=90.
func (d *Deps) SegmentGrowthReport(w http.ResponseWriter, r *http.Request) {
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
	if _, err := d.Repo.Get(r.Context(), t.ID, id); err != nil {
		if err == ErrNotFound {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out, err := d.buildGrowthReport(r, t.ID, id, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SegmentGrowthReportCSV GET /api/v1/segments/{id}/growth/report.csv.
func (d *Deps) SegmentGrowthReportCSV(w http.ResponseWriter, r *http.Request) {
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
	if _, err := d.Repo.Get(r.Context(), t.ID, id); err != nil {
		if err == ErrNotFound {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out, err := d.buildGrowthReport(r, t.ID, id, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="segment-growth-report.csv"`)
	w.WriteHeader(http.StatusOK)
	_ = growthReportCSV(w, id, out.Series)
}
