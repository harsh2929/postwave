package analytics

// Tests for A19 (GET /api/v1/analytics/timeseries) and the A22
// branch-aware funnel assembly. Both pipelines were factored into pure
// functions (assembleTimeseries / assembleFunnelSteps) precisely so the
// top-10+other rollup and the position-level dropoff math are testable
// without a DB.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---------------------------------------------------------------------
// A22: assembleFunnelSteps
// ---------------------------------------------------------------------

func TestAssembleFunnelSteps_LegacyRowsKeepOldBehavior(t *testing.T) {
	// One row per position, no step_id — the pre-0367 shape.
	raw := []FunnelStep{
		{Position: 0, Reached: 100, Opened: 50, Clicked: 10},
		{Position: 1, Reached: 80, Opened: 20, Clicked: 4},
		{Position: 2, Reached: 80, Opened: 8, Clicked: 0},
	}
	steps := assembleFunnelSteps(raw)
	if len(steps) != 3 {
		t.Fatalf("len = %d, want 3", len(steps))
	}
	if steps[0].DropoffPct != 0 {
		t.Errorf("position 0 dropoff = %v, want 0", steps[0].DropoffPct)
	}
	if steps[0].OpenRate != 50 || steps[0].ClickRate != 10 {
		t.Errorf("rates = %v/%v, want 50/10", steps[0].OpenRate, steps[0].ClickRate)
	}
	if steps[1].DropoffPct != 20 { // 100 -> 80
		t.Errorf("position 1 dropoff = %v, want 20", steps[1].DropoffPct)
	}
	if steps[2].DropoffPct != 0 { // 80 -> 80: no loss
		t.Errorf("position 2 dropoff = %v, want 0", steps[2].DropoffPct)
	}
}

func TestAssembleFunnelSteps_BranchRowsShareDropoff(t *testing.T) {
	// Position 1 splits into yes/no branch rows. Dropoff at position 1
	// is computed on the position TOTAL (40+30 vs 100) and stamped on
	// both rows; per-row rates use the row's own reach.
	raw := []FunnelStep{
		{Position: 0, StepID: "p0", Reached: 100, Opened: 60, Clicked: 10},
		{Position: 1, StepID: "p1:no:p1", Reached: 30, Opened: 3, Clicked: 0},
		{Position: 1, StepID: "p1:yes:p1", Reached: 40, Opened: 20, Clicked: 8},
	}
	steps := assembleFunnelSteps(raw)
	if len(steps) != 3 {
		t.Fatalf("len = %d, want 3", len(steps))
	}
	if steps[1].DropoffPct != 30 || steps[2].DropoffPct != 30 {
		t.Errorf("branch dropoffs = %v/%v, want 30/30 (position-level)",
			steps[1].DropoffPct, steps[2].DropoffPct)
	}
	if steps[1].OpenRate != 10 { // 3/30
		t.Errorf("no-branch open rate = %v, want 10", steps[1].OpenRate)
	}
	if steps[2].OpenRate != 50 || steps[2].ClickRate != 20 { // 20/40, 8/40
		t.Errorf("yes-branch rates = %v/%v, want 50/20",
			steps[2].OpenRate, steps[2].ClickRate)
	}
	// Step ids survive assembly (the desktop keys overlays on them).
	if steps[1].StepID != "p1:no:p1" || steps[2].StepID != "p1:yes:p1" {
		t.Errorf("step ids lost: %q %q", steps[1].StepID, steps[2].StepID)
	}
}

func TestFunnelStep_StepIDOmittedWhenEmpty(t *testing.T) {
	legacy, err := json.Marshal(FunnelStep{Position: 1, Reached: 5})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(legacy), "step_id") {
		t.Fatalf("legacy row must omit step_id: %s", legacy)
	}
	branch, err := json.Marshal(FunnelStep{Position: 1, StepID: "p1:yes:p1", Reached: 5})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(branch), `"step_id":"p1:yes:p1"`) {
		t.Fatalf("step_id missing: %s", branch)
	}
}

// ---------------------------------------------------------------------
// A19: assembleTimeseries + timeseriesDates
// ---------------------------------------------------------------------

func TestTimeseriesDates(t *testing.T) {
	now := time.Date(2026, 6, 10, 15, 30, 0, 0, time.UTC)
	got := timeseriesDates(now, 3)
	want := []string{"2026-06-08", "2026-06-09", "2026-06-10"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("dates[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestAssembleTimeseries(t *testing.T) {
	dates := []string{"2026-06-08", "2026-06-09", "2026-06-10"}
	byKey := map[string]map[string]int{
		"c1":    {"2026-06-08": 5, "2026-06-10": 2},
		"c2":    {"2026-06-09": 9},
		"other": {"2026-06-08": 100},
	}
	totals := map[string]int{"c1": 7, "c2": 9, "other": 100}
	labels := map[string]string{"c1": "Welcome blast"}

	series := assembleTimeseries(byKey, totals, labels, dates)
	if len(series) != 3 {
		t.Fatalf("len = %d, want 3", len(series))
	}
	// Volume-desc ordering among real groups; "other" forced last even
	// though it has the largest total.
	if series[0].Key != "c2" || series[1].Key != "c1" || series[2].Key != "other" {
		t.Fatalf("order = %s,%s,%s; want c2,c1,other",
			series[0].Key, series[1].Key, series[2].Key)
	}
	// Labels: explicit, key-fallback, "Other".
	if series[1].Label != "Welcome blast" {
		t.Errorf("c1 label = %q", series[1].Label)
	}
	if series[0].Label != "c2" {
		t.Errorf("c2 label fallback = %q, want key", series[0].Label)
	}
	if series[2].Label != "Other" {
		t.Errorf("other label = %q, want Other", series[2].Label)
	}
	// Zero-filled to exactly len(dates) points, in date order.
	for _, s := range series {
		if len(s.Points) != 3 {
			t.Fatalf("%s: %d points, want 3", s.Key, len(s.Points))
		}
	}
	c1 := series[1].Points
	if c1[0].Value != 5 || c1[1].Value != 0 || c1[2].Value != 2 {
		t.Errorf("c1 values = %d,%d,%d; want 5,0,2", c1[0].Value, c1[1].Value, c1[2].Value)
	}
	if c1[1].Date != "2026-06-09" {
		t.Errorf("c1 middle date = %q", c1[1].Date)
	}
}

func TestAssembleTimeseries_TieBreaksByKey(t *testing.T) {
	dates := []string{"2026-06-10"}
	byKey := map[string]map[string]int{
		"b.com": {"2026-06-10": 3},
		"a.com": {"2026-06-10": 3},
	}
	totals := map[string]int{"a.com": 3, "b.com": 3}
	series := assembleTimeseries(byKey, totals, nil, dates)
	if series[0].Key != "a.com" || series[1].Key != "b.com" {
		t.Fatalf("tie order = %s,%s; want a.com,b.com", series[0].Key, series[1].Key)
	}
}

// ---------------------------------------------------------------------
// A19: handler validation (no DB needed — all checked before Service)
// ---------------------------------------------------------------------

func groupedTSRequest(t *testing.T, query string, withTenant bool) *httptest.ResponseRecorder {
	t.Helper()
	d := &ExtendedDeps{Service: &Service{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/analytics/timeseries"+query, nil)
	if withTenant {
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
			ID: "00000000-0000-0000-0000-000000000001",
		}))
	}
	rec := httptest.NewRecorder()
	d.GroupedTimeseries(rec, req)
	return rec
}

func TestGroupedTimeseries_RequiresTenant(t *testing.T) {
	rec := groupedTSRequest(t, "?group_by=campaign", false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestGroupedTimeseries_Validation(t *testing.T) {
	cases := []struct {
		query    string
		wantCode string
	}{
		{"", "bad_group_by"},
		{"?group_by=subscriber", "bad_group_by"},
		{"?group_by=list", "unsupported_dimension"}, // recognized, honestly rejected
		{"?group_by=campaign&metric=revenue", "bad_metric"},
		{"?group_by=campaign&days=0", "bad_days"},
		{"?group_by=campaign&days=-3", "bad_days"},
		{"?group_by=campaign&days=soon", "bad_days"},
	}
	for _, tc := range cases {
		rec := groupedTSRequest(t, tc.query, true)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: status = %d, want 400 (body=%s)", tc.query, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.wantCode) {
			t.Errorf("%q: body = %s, want code %s", tc.query, rec.Body.String(), tc.wantCode)
		}
	}
}
