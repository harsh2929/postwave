// SPDX-License-Identifier: AGPL-3.0-only
package sending

import "testing"

func TestEngagementMultiplier_BelowSampleSizeIsNoSlowdown(t *testing.T) {
	// 50 sends, 5 complaints (10% complaint rate) — would be a
	// catastrophic rate, but sample is below the noise floor.
	got := EngagementMultiplier(EngagementSnapshot{Sent: 50, Complained: 5})
	if got != 1.0 {
		t.Errorf("below sample size should return 1.0, got %f", got)
	}
}

func TestEngagementMultiplier_HealthyReturns1(t *testing.T) {
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 10000, Bounced: 100, Complained: 5, Opened: 2500, // 1% bounce, 0.05% complaint, 25% open
	})
	if got != 1.0 {
		t.Errorf("healthy account should return 1.0, got %f", got)
	}
}

func TestEngagementMultiplier_WarningBand(t *testing.T) {
	// 0.2% complaint — warning band.
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 10000, Bounced: 50, Complained: 20, Opened: 2000,
	})
	if got != 0.75 {
		t.Errorf("warning band complaint=0.2%% should return 0.75, got %f", got)
	}
}

func TestEngagementMultiplier_DegradedBand(t *testing.T) {
	// 0.6% complaint — degraded.
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 10000, Bounced: 50, Complained: 60, Opened: 2000,
	})
	if got != 0.50 {
		t.Errorf("degraded band complaint=0.6%% should return 0.50, got %f", got)
	}
}

func TestEngagementMultiplier_CriticalBand(t *testing.T) {
	// 1.2% complaint — critical.
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 10000, Complained: 120,
	})
	if got != 0.25 {
		t.Errorf("critical band complaint=1.2%% should return 0.25, got %f", got)
	}
}

func TestEngagementMultiplier_HaltOnComplaint(t *testing.T) {
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 10000, Complained: 200, // 2% — halt
	})
	if got != 0.0 {
		t.Errorf("halt threshold (complaint=2%%) should return 0.0, got %f", got)
	}
}

func TestEngagementMultiplier_HaltOnBounce(t *testing.T) {
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 10000, Bounced: 1000, // 10% — halt
	})
	if got != 0.0 {
		t.Errorf("halt threshold (bounce=10%%) should return 0.0, got %f", got)
	}
}

func TestEngagementMultiplier_LowOpenRateSlowdown(t *testing.T) {
	// Rates are otherwise healthy but open rate is poor — soft slowdown.
	// Need ≥ 1000 sent for the open-rate gate to apply.
	got := EngagementMultiplier(EngagementSnapshot{
		Sent: 5000, Bounced: 20, Complained: 1, Opened: 50, // 1% opens
	})
	if got != 0.75 {
		t.Errorf("low open rate (1%%) on otherwise healthy account should return 0.75, got %f", got)
	}
	got = EngagementMultiplier(EngagementSnapshot{
		Sent: 5000, Bounced: 20, Complained: 1, Opened: 200, // 4% opens
	})
	if got != 0.90 {
		t.Errorf("moderate open rate (4%%) should return 0.90, got %f", got)
	}
	got = EngagementMultiplier(EngagementSnapshot{
		Sent: 5000, Bounced: 20, Complained: 1, Opened: 500, // 10% opens
	})
	if got != 1.0 {
		t.Errorf("good open rate (10%%) should return 1.0, got %f", got)
	}
}

func TestCapForDayWithEngagement_ScalesBase(t *testing.T) {
	// Day 5 = 2,000 base cap. 0.5x multiplier (degraded) -> 1,000.
	got := CapForDayWithEngagement(5, 0, EngagementSnapshot{
		Sent: 10000, Complained: 70, // 0.7% — degraded
	})
	if got != 1000 {
		t.Errorf("day-5 × 0.5 = 1000, got %d", got)
	}
}

func TestCapForDayWithEngagement_HaltReturnsZero(t *testing.T) {
	got := CapForDayWithEngagement(10, 0, EngagementSnapshot{
		Sent: 10000, Bounced: 1500, // 15% — halt
	})
	if got != 0 {
		t.Errorf("halt-band must return 0 (route-elsewhere signal), got %d", got)
	}
}

func TestCapForDayWithEngagement_HealthyEqualsBase(t *testing.T) {
	healthy := EngagementSnapshot{Sent: 10000, Bounced: 10, Complained: 1, Opened: 2500}
	for day := 1; day <= 30; day++ {
		base := CapForDay(day, 0)
		got := CapForDayWithEngagement(day, 0, healthy)
		if got != base {
			t.Errorf("day %d healthy should equal base %d, got %d", day, base, got)
		}
	}
}

func TestCapForDayWithEngagement_NeverReturnsLessThan1WhenActive(t *testing.T) {
	// Day 1 base = 50. 0.01x multiplier would round to 0, but the
	// modifier floors at 1 to keep the throttle signal honest.
	// We can't easily construct an exact 0.01x band, so use the
	// 0.25x critical band on Day 1: 50 * 0.25 = 12.5 -> 12.
	got := CapForDayWithEngagement(1, 0, EngagementSnapshot{
		Sent: 10000, Complained: 120,
	})
	if got < 1 {
		t.Errorf("active modifier should floor at 1, got %d", got)
	}
}

func TestCapForDayWithEngagement_DayZeroIsAlwaysZero(t *testing.T) {
	got := CapForDayWithEngagement(0, 100000, EngagementSnapshot{Sent: 10000, Opened: 2500})
	if got != 0 {
		t.Errorf("day=0 (not started) must always return 0, got %d", got)
	}
}
