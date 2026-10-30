// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import "testing"

// A small holdout must not report a lift number.
//
// This is the case the PRD singles out: "A lift figure from an underpowered
// test is worse than no figure." 4 clicks from 100 vs 6 from 100 is a 50%
// relative lift and is entirely consistent with noise; a reader shown "+50%"
// has no way to tell it from a real result, because the two render identically.
func TestASmallSampleReportsUnderpoweredInsteadOfALift(t *testing.T) {
	got := ComputeLiftSignificance(4, 100, 6, 100)

	if got.Powered {
		t.Fatal("a 100-vs-100 comparison with single-digit conversions was reported " +
			"as powered; a noise figure will be rendered as a result")
	}
	if got.AbsoluteLift != nil || got.RelativeLift != nil || got.IncrementalConversions != nil {
		t.Fatalf("underpowered result still carries lift numbers: abs=%v rel=%v inc=%v — "+
			"a caller that reads them will display them",
			got.AbsoluteLift, got.RelativeLift, got.IncrementalConversions)
	}
	if got.Reason == "" {
		t.Error("no reason given; the UI has nothing to explain the absence with")
	}
	// The rates themselves are still honest facts and stay available.
	if got.ControlRate != 0.04 || got.TreatmentRate != 0.06 {
		t.Errorf("rates = %v / %v, want 0.04 / 0.06", got.ControlRate, got.TreatmentRate)
	}
}

// A large, clearly-separated comparison does report one, with an interval.
func TestAPoweredComparisonReportsLiftWithAnInterval(t *testing.T) {
	// 2% vs 4% on 50k a side: a real, detectable difference.
	got := ComputeLiftSignificance(1000, 50_000, 2000, 50_000)

	if !got.Powered {
		t.Fatalf("a 50k-per-arm comparison at 2%% vs 4%% was called underpowered: %s", got.Reason)
	}
	if got.AbsoluteLift == nil || got.CILow == nil || got.CIHigh == nil {
		t.Fatal("powered result is missing lift or interval")
	}
	if got.PValue > 0.001 {
		t.Errorf("p = %v, expected a decisive result", got.PValue)
	}
	// The interval must exclude zero for a result this clear, and must bracket
	// the point estimate — an interval that does not contain its own estimate is
	// the classic sign of a pooled/unpooled mix-up.
	if *got.CILow <= 0 {
		t.Errorf("ci_low = %v, expected an interval excluding zero", *got.CILow)
	}
	if *got.AbsoluteLift < *got.CILow || *got.AbsoluteLift > *got.CIHigh {
		t.Errorf("point estimate %v lies outside its own interval [%v, %v]",
			*got.AbsoluteLift, *got.CILow, *got.CIHigh)
	}
	if got.IncrementalConversions == nil || *got.IncrementalConversions <= 0 {
		t.Error("incremental conversions missing on a powered positive result")
	}
}

// No data must not read as "no effect".
func TestEmptyArmsAreNotAZeroLift(t *testing.T) {
	got := ComputeLiftSignificance(0, 0, 0, 0)
	if got.Powered {
		t.Fatal("an empty comparison was reported as powered")
	}
	if got.PValue != 1 {
		t.Errorf("p = %v on empty data, want 1 — a 0 would make `p < alpha` fire "+
			"on nothing at all", got.PValue)
	}
	if got.AbsoluteLift != nil {
		t.Error("empty comparison carries a lift value")
	}
}

// A control arm with zero conversions has no baseline to lift.
func TestAZeroControlRateIsNotAnInfiniteLift(t *testing.T) {
	got := ComputeLiftSignificance(0, 5_000, 250, 5_000)
	if got.RelativeLift != nil {
		t.Errorf("relative lift = %v against a zero control rate; the division is "+
			"undefined and any number here is fabricated", *got.RelativeLift)
	}
}

func TestPowerUsesTheFrozenMinimumRelativeEffect(t *testing.T) {
	// At a 10% baseline, 1,000 recipients per arm cannot resolve a 10%
	// relative effect (one percentage point), but can resolve a configured 50%
	// relative effect (five points). The observed rates are equal, so only the
	// configured design threshold can change the power disposition.
	strict := ComputeLiftSignificanceForEffect(100, 1_000, 100, 1_000, 0.10)
	if strict.Powered {
		t.Fatalf("10%% configured effect unexpectedly powered: %+v", strict)
	}
	coarse := ComputeLiftSignificanceForEffect(100, 1_000, 100, 1_000, 0.50)
	if !coarse.Powered {
		t.Fatalf("50%% configured effect was ignored: %+v", coarse)
	}
	if coarse.AbsoluteLift == nil || *coarse.AbsoluteLift != 0 {
		t.Fatalf("powered null result absolute lift = %v, want explicit zero", coarse.AbsoluteLift)
	}
}
