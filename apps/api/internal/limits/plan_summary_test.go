// SPDX-License-Identifier: AGPL-3.0-only
//
// plan_summary_test.go — pure unit tests for the monthly_sends
// projection math. No database: ComputeSendsProjection is a pure
// function of (current, limit, periodStart, periodEnd, now).

package limits

import (
	"testing"
	"time"
)

// june is a fixed 30-day month so the day arithmetic is easy to reason about.
var (
	periodStart = time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	periodEnd   = time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC) // 30 days
)

func TestComputeSendsProjection_OnTrackToExceed(t *testing.T) {
	// 38,000 sends over 20 elapsed days, cap 50,000.
	// avg_per_day = 38000/20 = 1900; projected end = 1900*30 = 57000 > 50000.
	now := periodStart.AddDate(0, 0, 20) // 20 days elapsed
	p := ComputeSendsProjection(38000, 50000, periodStart, periodEnd, now)

	if p.AvgPerDay != 1900 {
		t.Fatalf("avg_per_day = %d, want 1900", p.AvgPerDay)
	}
	if p.DaysElapsed != 20 {
		t.Fatalf("days_elapsed = %d, want 20", p.DaysElapsed)
	}
	if p.DaysInPeriod != 30 {
		t.Fatalf("days_in_period = %d, want 30", p.DaysInPeriod)
	}
	if p.ProjectedEndOfPeriod != 57000 {
		t.Fatalf("projected_end_of_period = %d, want 57000", p.ProjectedEndOfPeriod)
	}
	if !p.OnTrackToExceed {
		t.Fatalf("on_track_to_exceed = false, want true")
	}
	// ceil(50000/1900) = ceil(26.3) = 27 → June 1 + 27 days = June 28.
	if p.ProjectedExceedDate == nil {
		t.Fatalf("projected_exceed_date = nil, want a date")
	}
	if got := *p.ProjectedExceedDate; got != "2026-06-28" {
		t.Fatalf("projected_exceed_date = %q, want 2026-06-28", got)
	}
}

func TestComputeSendsProjection_NotOnTrack(t *testing.T) {
	// 10,000 sends over 20 days, cap 50,000.
	// avg = 500/day; projected end = 500*30 = 15000 < 50000 → no exceed.
	now := periodStart.AddDate(0, 0, 20)
	p := ComputeSendsProjection(10000, 50000, periodStart, periodEnd, now)

	if p.AvgPerDay != 500 {
		t.Fatalf("avg_per_day = %d, want 500", p.AvgPerDay)
	}
	if p.ProjectedEndOfPeriod != 15000 {
		t.Fatalf("projected_end_of_period = %d, want 15000", p.ProjectedEndOfPeriod)
	}
	if p.OnTrackToExceed {
		t.Fatalf("on_track_to_exceed = true, want false")
	}
	if p.ProjectedExceedDate != nil {
		t.Fatalf("projected_exceed_date = %q, want nil", *p.ProjectedExceedDate)
	}
}

func TestComputeSendsProjection_NoUsage(t *testing.T) {
	// Zero sends → honest zero, never a fabricated trend.
	now := periodStart.AddDate(0, 0, 10)
	p := ComputeSendsProjection(0, 50000, periodStart, periodEnd, now)

	if p.AvgPerDay != 0 {
		t.Fatalf("avg_per_day = %d, want 0", p.AvgPerDay)
	}
	if p.ProjectedEndOfPeriod != 0 {
		t.Fatalf("projected_end_of_period = %d, want 0", p.ProjectedEndOfPeriod)
	}
	if p.OnTrackToExceed {
		t.Fatalf("on_track_to_exceed = true, want false")
	}
	if p.ProjectedExceedDate != nil {
		t.Fatalf("projected_exceed_date = %q, want nil", *p.ProjectedExceedDate)
	}
}

func TestComputeSendsProjection_ZeroDaysElapsed(t *testing.T) {
	// now == period start: no full day elapsed and no partial time → no
	// division by zero, no projection.
	p := ComputeSendsProjection(5000, 50000, periodStart, periodEnd, periodStart)

	if p.DaysElapsed != 0 {
		t.Fatalf("days_elapsed = %d, want 0", p.DaysElapsed)
	}
	if p.AvgPerDay != 0 {
		t.Fatalf("avg_per_day = %d, want 0 (no days elapsed)", p.AvgPerDay)
	}
	if p.OnTrackToExceed || p.ProjectedExceedDate != nil {
		t.Fatalf("expected no projection with zero elapsed days")
	}
}

func TestComputeSendsProjection_PartialFirstDayCountsAsOne(t *testing.T) {
	// 6 hours into the period with sends: a partial first day counts as 1
	// so we still project (and never divide by zero).
	now := periodStart.Add(6 * time.Hour)
	p := ComputeSendsProjection(2000, 50000, periodStart, periodEnd, now)

	if p.DaysElapsed != 1 {
		t.Fatalf("days_elapsed = %d, want 1 (partial day)", p.DaysElapsed)
	}
	if p.AvgPerDay != 2000 {
		t.Fatalf("avg_per_day = %d, want 2000", p.AvgPerDay)
	}
	if p.ProjectedEndOfPeriod != 60000 {
		t.Fatalf("projected_end_of_period = %d, want 60000", p.ProjectedEndOfPeriod)
	}
}

func TestComputeSendsProjection_NoLimitNoExceed(t *testing.T) {
	// limit == 0 (unmetered) → never reports an exceed date.
	now := periodStart.AddDate(0, 0, 15)
	p := ComputeSendsProjection(30000, 0, periodStart, periodEnd, now)

	if p.OnTrackToExceed {
		t.Fatalf("on_track_to_exceed = true, want false for unmetered")
	}
	if p.ProjectedExceedDate != nil {
		t.Fatalf("projected_exceed_date = %q, want nil for unmetered", *p.ProjectedExceedDate)
	}
}

func TestBuildSendsProjection_UsesCalendarMonthWindow(t *testing.T) {
	// BuildSendsProjection wires the calendar-month window from `now`.
	now := time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) // 20 full days elapsed
	row := &UsageRow{Resource: string(ResourceMonthlySends), Current: 38000, Limit: 50000}
	p := BuildSendsProjection(row, now)
	if p == nil {
		t.Fatal("projection = nil")
	}
	if p.DaysInPeriod != 30 {
		t.Fatalf("days_in_period = %d, want 30 (June)", p.DaysInPeriod)
	}
	if p.DaysElapsed != 20 {
		t.Fatalf("days_elapsed = %d, want 20", p.DaysElapsed)
	}
	if p.AvgPerDay != 1900 {
		t.Fatalf("avg_per_day = %d, want 1900", p.AvgPerDay)
	}
	if !p.OnTrackToExceed {
		t.Fatal("on_track_to_exceed = false, want true")
	}
}

func TestBuildSendsProjection_NilRow(t *testing.T) {
	if got := BuildSendsProjection(nil, time.Now()); got != nil {
		t.Fatalf("BuildSendsProjection(nil) = %+v, want nil", got)
	}
}
