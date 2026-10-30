// SPDX-License-Identifier: AGPL-3.0-only
//
// growth_report_test.go — pure-function tests for SUB-031 segment growth
// report (day-delta merge, anomaly correlation, window summary, CSV) plus
// a handler auth guard. No live DB: the assembly helpers are pure.

package segments

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMergeGrowthReportRows(t *testing.T) {
	counts := []GrowthPoint{
		{Date: "2026-06-01", Count: 100},
		{Date: "2026-06-02", Count: 130},
		{Date: "2026-06-03", Count: 120},
	}
	churn := []dailyChurn{
		{Date: "2026-06-02", Adds: 35, Drops: 5},
		{Date: "2026-06-03", Adds: 2, Drops: 12},
		// A churn-only day with no count row must be dropped.
		{Date: "2026-05-31", Adds: 99, Drops: 99},
	}
	got := mergeGrowthReportRows(counts, churn)
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3 (count series is authoritative)", len(got))
	}
	// First day: no churn, delta 0.
	if got[0].Adds != 0 || got[0].Drops != 0 || got[0].Delta != 0 {
		t.Fatalf("day0 = %+v, want zero churn + zero delta", got[0])
	}
	// Second day: churn merged, delta = 130-100 = 30.
	if got[1].Adds != 35 || got[1].Drops != 5 || got[1].Delta != 30 {
		t.Fatalf("day1 = %+v, want adds=35 drops=5 delta=30", got[1])
	}
	// Third day: delta = 120-130 = -10.
	if got[2].Delta != -10 {
		t.Fatalf("day2 delta = %d, want -10", got[2].Delta)
	}
}

func TestMergeGrowthReportRowsCapDisclosure(t *testing.T) {
	counts := []GrowthPoint{{Date: "2026-06-02", Count: 5000}}
	churn := []dailyChurn{{Date: "2026-06-02", Adds: MembershipLogCapPerDirection, Drops: 3}}
	got := mergeGrowthReportRows(counts, churn)
	if !got[0].CappedAdds {
		t.Fatal("adds at the cap must set CappedAdds")
	}
	if got[0].CappedDrops {
		t.Fatal("drops below cap must NOT set CappedDrops")
	}
}

func TestCorrelateAnomaliesImpl(t *testing.T) {
	series := []GrowthReportPoint{
		{Date: "2026-06-01", Count: 100},
		{Date: "2026-06-02", Count: 40},
		{Date: "2026-06-03", Count: 45},
	}
	events := []DecayEvent{
		{SnapshotDate: "2026-06-02", AnomalyKind: AnomalySizeCliff, PriorCount: 100, NewCount: 40, LeaverCount: 60},
	}
	anomalies := correlateAnomaliesImpl(series, events)
	if len(anomalies) != 1 {
		t.Fatalf("anomalies len = %d, want 1", len(anomalies))
	}
	if anomalies[0].AnomalyKind != AnomalySizeCliff || anomalies[0].LeaverCount != 60 {
		t.Fatalf("anomaly = %+v", anomalies[0])
	}
	// The matching day must be stamped; the others must stay empty.
	if series[1].AnomalyKind != AnomalySizeCliff {
		t.Fatalf("day1 not stamped: %q", series[1].AnomalyKind)
	}
	if series[0].AnomalyKind != "" || series[2].AnomalyKind != "" {
		t.Fatal("non-matching days must not be stamped")
	}
}

func TestCorrelateAnomaliesImplEmpty(t *testing.T) {
	series := []GrowthReportPoint{{Date: "2026-06-01", Count: 100}}
	got := correlateAnomaliesImpl(series, nil)
	if got == nil || len(got) != 0 {
		t.Fatalf("want empty non-nil slice, got %v", got)
	}
}

func TestSummariseGrowthReport(t *testing.T) {
	series := []GrowthReportPoint{
		{Date: "2026-06-01", Count: 100, Adds: 0, Drops: 0},
		{Date: "2026-06-02", Count: 130, Adds: 35, Drops: 5},
		{Date: "2026-06-03", Count: 125, Adds: 2, Drops: 7},
	}
	adds, drops, netDelta, netPct := summariseGrowthReport(series)
	if adds != 37 || drops != 12 {
		t.Fatalf("totals adds=%d drops=%d, want 37/12", adds, drops)
	}
	if netDelta != 25 {
		t.Fatalf("netDelta = %d, want 25", netDelta)
	}
	// 25 / 100 * 100 = 25%.
	if netPct < 24.99 || netPct > 25.01 {
		t.Fatalf("netPct = %f, want ~25", netPct)
	}
}

func TestSummariseGrowthReportShortSeries(t *testing.T) {
	_, _, netDelta, netPct := summariseGrowthReport([]GrowthReportPoint{{Count: 100}})
	if netDelta != 0 || netPct != 0 {
		t.Fatalf("single-point series must yield zero net, got delta=%d pct=%f", netDelta, netPct)
	}
}

func TestGrowthReportCSV(t *testing.T) {
	series := []GrowthReportPoint{
		{Date: "2026-06-02", Count: 130, Adds: 35, Drops: 5, Delta: 30, AnomalyKind: AnomalySizeCliff, CappedAdds: true},
	}
	var buf bytes.Buffer
	if err := growthReportCSV(&buf, "seg-1", series); err != nil {
		t.Fatalf("csv err = %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "segment_id,date,count,adds,drops,capped_adds,capped_drops,delta,anomaly_kind") {
		t.Fatalf("missing header: %s", out)
	}
	if !strings.Contains(out, "seg-1,2026-06-02,130,35,5,true,false,30,size_cliff") {
		t.Fatalf("missing data row: %s", out)
	}
}

func TestSegmentGrowthReportHandlerNoTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/seg-1/growth/report", nil)
	req = withChiID(req, "id", "seg-1")
	rec := httptest.NewRecorder()
	d.SegmentGrowthReport(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSegmentGrowthReportCSVHandlerNoTenant(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/seg-1/growth/report.csv", nil)
	req = withChiID(req, "id", "seg-1")
	rec := httptest.NewRecorder()
	d.SegmentGrowthReportCSV(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}
