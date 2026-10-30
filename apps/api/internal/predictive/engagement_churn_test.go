package predictive

import (
	"math"
	"testing"
	"time"
)

func TestEngagementChurnRiskBanding(t *testing.T) {
	cases := []struct {
		days int
		want float64
	}{
		{-1, EngagementChurnVeryHigh}, // never engaged -> max
		{0, EngagementChurnRecent},
		{30, EngagementChurnRecent},  // inclusive upper edge of recent
		{31, EngagementChurnCooling}, // crosses into cooling
		{60, EngagementChurnCooling},
		{61, EngagementChurnAtRisk},
		{90, EngagementChurnAtRisk},
		{91, EngagementChurnHigh},
		{120, EngagementChurnHigh},
		{121, EngagementChurnVeryHigh},
		{400, EngagementChurnVeryHigh},
	}
	for _, c := range cases {
		if got := EngagementChurnRisk(c.days); got != c.want {
			t.Errorf("EngagementChurnRisk(%d) = %v, want %v", c.days, got, c.want)
		}
	}
}

// TestEngagementChurnRiskMonotone pins the key product contract: risk is
// non-decreasing as days-since-activity grows, so a more-dormant
// subscriber is never scored LESS at-risk than a fresher one.
func TestEngagementChurnRiskMonotone(t *testing.T) {
	prev := EngagementChurnRisk(0)
	for d := 1; d <= 400; d++ {
		got := EngagementChurnRisk(d)
		if got < prev {
			t.Fatalf("risk decreased at d=%d: %v < %v", d, got, prev)
		}
		prev = got
	}
}

// TestEngagementChurnThresholdGate checks the default win-back threshold
// (0.70) fires at "no activity in 60+ days" — i.e. the at-risk band and
// beyond cross the gate, while recent/cooling do not.
func TestEngagementChurnThresholdGate(t *testing.T) {
	const threshold = 0.70
	if EngagementChurnRisk(30) >= threshold || EngagementChurnRisk(60) >= threshold {
		t.Fatal("recent/cooling subscribers should not cross the 0.70 gate")
	}
	if EngagementChurnRisk(61) < threshold || EngagementChurnRisk(-1) < threshold {
		t.Fatal("at-risk and never-engaged subscribers should cross the 0.70 gate")
	}
}

func TestEngagementChurnContinuous(t *testing.T) {
	if got := EngagementChurnContinuous(-1); got != 1 {
		t.Fatalf("never engaged continuous = %v, want 1", got)
	}
	if got := EngagementChurnContinuous(0); got != 0 {
		t.Fatalf("d=0 continuous = %v, want 0", got)
	}
	// d=30 -> 1-exp(-1) ~= 0.632.
	if got := EngagementChurnContinuous(30); math.Abs(got-0.6321) > 0.01 {
		t.Fatalf("d=30 continuous = %v, want ~0.632", got)
	}
	// Monotone increasing.
	if EngagementChurnContinuous(90) <= EngagementChurnContinuous(30) {
		t.Fatal("continuous risk should increase with days")
	}
}

func TestSortEngagementByRiskDesc(t *testing.T) {
	rows := []EngagementChurnRow{
		{Email: "cooling@x", DaysSinceActivity: 45, ChurnRisk: EngagementChurnCooling},
		{Email: "never@x", DaysSinceActivity: -1, ChurnRisk: EngagementChurnVeryHigh},
		{Email: "atrisk@x", DaysSinceActivity: 70, ChurnRisk: EngagementChurnAtRisk},
		{Email: "veryold@x", DaysSinceActivity: 200, ChurnRisk: EngagementChurnVeryHigh},
	}
	sortEngagementByRiskDesc(rows)
	// Highest risk first; within the very-high tie, the never-engaged (-1
	// sentinel, stalest) ranks ahead of the 200-day one.
	wantOrder := []string{"never@x", "veryold@x", "atrisk@x", "cooling@x"}
	for i, w := range wantOrder {
		if rows[i].Email != w {
			t.Fatalf("position %d = %q, want %q (full=%+v)", i, rows[i].Email, w, rows)
		}
	}
}

// TestChurnDriverRecencyFallbackBands pins SUB-060: when a profile has no
// established cadence (avgDays nil — a single order or none), the recency
// churn driver falls back to absolute recency bands aligned with the
// engagement-churn model edges (recent / at-risk).
func TestChurnDriverRecencyFallbackBands(t *testing.T) {
	now := time.Date(2026, 6, 13, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name       string
		daysAgo    int
		wantImpact string
	}{
		{"recent within recent band", engagementBandRecentDays - 5, "low"},
		{"cooling between recent and at-risk", engagementBandRecentDays + 10, "medium"},
		{"past at-risk band", engagementBandAtRiskDays + 5, "high"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			last := now.AddDate(0, 0, -c.daysAgo)
			// avgDays nil: a single order gives no cadence.
			drivers := computeChurnDrivers(ProfileSignals{
				OrderCount:  1,
				LastOrderAt: &last,
			}, nil, now)
			var recency *ChurnDriver
			for i := range drivers {
				if drivers[i].Key == "recency" {
					recency = &drivers[i]
				}
			}
			if recency == nil {
				t.Fatalf("expected a recency driver, got %+v", drivers)
			}
			if recency.Impact != c.wantImpact {
				t.Fatalf("recency impact = %q, want %q (days=%d)", recency.Impact, c.wantImpact, c.daysAgo)
			}
		})
	}
}

func TestEngagementChurnAsOf(t *testing.T) {
	now := time.Date(2026, 6, 13, 0, 0, 0, 0, time.UTC)
	// 70 days ago -> at-risk band.
	d70 := now.AddDate(0, 0, -70)
	if got := EngagementChurnAsOf(&d70, now); got != EngagementChurnAtRisk {
		t.Fatalf("70-day-old activity = %v, want at-risk", got)
	}
	// nil last activity -> max risk.
	if got := EngagementChurnAsOf(nil, now); got != EngagementChurnVeryHigh {
		t.Fatalf("nil activity = %v, want very-high", got)
	}
	// Future timestamp clamps to 0 days -> recent.
	future := now.AddDate(0, 0, 5)
	if got := EngagementChurnAsOf(&future, now); got != EngagementChurnRecent {
		t.Fatalf("future activity = %v, want recent", got)
	}
}
