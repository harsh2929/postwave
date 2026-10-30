// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-Go tests for goals: input validation, period-window math, and
// pacing classification. DB-backed paths are covered by the
// project-wide pg-backed convention elsewhere (skip without
// DATABASE_URL); the progress source queries are exercised in
// goals_db_test-style suites when a database is present.

package goals

import (
	"errors"
	"testing"
	"time"
)

func TestCreateInputValidate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   CreateInput
		want error
	}{
		{"bad metric", CreateInput{Metric: "clicks", Target: 10}, ErrInvalidMetric},
		{"empty metric", CreateInput{Target: 10}, ErrInvalidMetric},
		{"zero target", CreateInput{Metric: "subscribers"}, ErrInvalidTarget},
		{"negative target", CreateInput{Metric: "subscribers", Target: -5}, ErrInvalidTarget},
		{"bad period", CreateInput{Metric: "subscribers", Target: 10, Period: "weekly"}, ErrInvalidPeriod},
		{"ok defaults", CreateInput{Metric: "Subscribers", Target: 10}, nil},
		{"ok quarterly", CreateInput{Metric: "revenue_cents", Target: 100000, Period: "quarterly"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.in.validate()
			if !errors.Is(err, tc.want) {
				t.Fatalf("validate() = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestCreateInputValidateDefaultsPeriod(t *testing.T) {
	t.Parallel()
	in := CreateInput{Metric: "open_rate", Target: 25}
	if err := in.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if in.Period != "monthly" {
		t.Fatalf("period default = %q, want monthly", in.Period)
	}
	if in.Metric != "open_rate" {
		t.Fatalf("metric normalised = %q", in.Metric)
	}
}

func TestOptionalExpectedUpdatedAt(t *testing.T) {
	t.Parallel()

	if got, err := optionalExpectedUpdatedAt(""); err != nil || got != nil {
		t.Fatalf("empty expected_updated_at = (%v, %v), want (nil, nil)", got, err)
	}
	want := time.Date(2026, 8, 30, 10, 15, 16, 123456000, time.UTC)
	got, err := optionalExpectedUpdatedAt(want.Format(time.RFC3339Nano))
	if err != nil || got == nil || !got.Equal(want) {
		t.Fatalf("valid expected_updated_at = (%v, %v), want %v", got, err, want)
	}
	for _, raw := range []string{"today", "0001-01-01T00:00:00Z"} {
		if got, err := optionalExpectedUpdatedAt(raw); err == nil || got != nil {
			t.Fatalf("optionalExpectedUpdatedAt(%q) = (%v, %v), want error", raw, got, err)
		}
	}
}

func TestCurrentPeriodWindow(t *testing.T) {
	t.Parallel()
	anchor := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)

	// now inside the first monthly window.
	start, end := CurrentPeriodWindow(anchor, "monthly", time.Date(2026, 1, 20, 0, 0, 0, 0, time.UTC))
	if !start.Equal(anchor) || !end.Equal(anchor.AddDate(0, 1, 0)) {
		t.Fatalf("first window = [%v, %v)", start, end)
	}

	// now three months later — fourth monthly window.
	now := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	start, end = CurrentPeriodWindow(anchor, "monthly", now)
	wantStart := time.Date(2026, 4, 15, 0, 0, 0, 0, time.UTC)
	if !start.Equal(wantStart) {
		t.Fatalf("window start = %v, want %v", start, wantStart)
	}
	if !now.Before(end) || now.Before(start) {
		t.Fatalf("now %v outside window [%v, %v)", now, start, end)
	}

	// quarterly: second window.
	start, end = CurrentPeriodWindow(anchor, "quarterly", time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC))
	if !start.Equal(time.Date(2026, 4, 15, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("quarterly window start = %v", start)
	}
	if !end.Equal(time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("quarterly window end = %v", end)
	}

	// now before starts_at → first window.
	start, _ = CurrentPeriodWindow(anchor, "monthly", anchor.AddDate(0, 0, -10))
	if !start.Equal(anchor) {
		t.Fatalf("pre-anchor window start = %v, want %v", start, anchor)
	}
}

func TestComputePace(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0) // 30-day window
	mid := start.Add(end.Sub(start) / 2)

	cases := []struct {
		name     string
		current  float64
		target   float64
		now      time.Time
		wantPace string
	}{
		{"halfway with 50% progress", 50, 100, mid, "on_track"},
		{"halfway with 70% progress", 70, 100, mid, "ahead"},
		{"halfway with 30% progress", 30, 100, mid, "behind"},
		{"window start, zero progress", 0, 100, start, "on_track"},
		{"window start, any progress", 10, 100, start, "ahead"},
		{"window end, complete", 100, 100, end, "on_track"},
		{"window end, incomplete", 80, 100, end, "behind"},
		{"over-achieved", 250, 100, mid, "ahead"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pct, pace := ComputePace(tc.current, tc.target, start, end, tc.now)
			if pace != tc.wantPace {
				t.Fatalf("pace = %q (pct=%.2f), want %q", pace, pct, tc.wantPace)
			}
		})
	}

	// pct math.
	pct, _ := ComputePace(25, 100, start, end, mid)
	if pct != 0.25 {
		t.Fatalf("pct = %v, want 0.25", pct)
	}
	// zero target never divides by zero.
	pct, _ = ComputePace(25, 0, start, end, mid)
	if pct != 0 {
		t.Fatalf("zero-target pct = %v, want 0", pct)
	}
}
