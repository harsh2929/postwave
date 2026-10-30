// SPDX-License-Identifier: AGPL-3.0-only

package reporting

import (
	"testing"
	"time"
)

func TestResolveWindow(t *testing.T) {
	dayDiff := func(a, b time.Time) float64 { return b.Sub(a).Hours() / 24 }

	// Default (empty range) is a trailing 30 days.
	since, until := resolveWindow(TimeRange{})
	if d := dayDiff(since, until); d < 29.9 || d > 30.1 {
		t.Fatalf("default window = %.2f days, want ~30", d)
	}

	// Presets map to their trailing windows.
	for preset, want := range map[string]int{"24h": 1, "7d": 7, "14d": 14, "90d": 90, "365d": 365} {
		since, until = resolveWindow(TimeRange{Preset: preset})
		if d := dayDiff(since, until); d < float64(want)-0.1 || d > float64(want)+0.1 {
			t.Fatalf("preset %q window = %.2f days, want %d", preset, d, want)
		}
	}

	// An unknown preset falls back to 30 days (not zero/unbounded).
	since, until = resolveWindow(TimeRange{Preset: "bogus"})
	if d := dayDiff(since, until); d < 29.9 || d > 30.1 {
		t.Fatalf("unknown preset window = %.2f days, want ~30", d)
	}

	// Explicit From/To wins over any preset.
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)
	since, until = resolveWindow(TimeRange{Preset: "7d", From: &from, To: &to})
	if !since.Equal(from) || !until.Equal(to) {
		t.Fatalf("explicit range not honored: %v..%v", since, until)
	}

	// From alone keeps the upper bound at ~now.
	since, until = resolveWindow(TimeRange{From: &from})
	if !since.Equal(from) {
		t.Fatalf("From not honored: %v", since)
	}
	if time.Since(until) > time.Minute {
		t.Fatalf("From-only upper bound should be ~now, got %v", until)
	}
}
