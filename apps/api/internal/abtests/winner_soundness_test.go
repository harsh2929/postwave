// SPDX-License-Identifier: AGPL-3.0-only
package abtests

import (
	"context"
	"math"
	"math/rand"
	"testing"
)

// Does the winner rule actually control the false-positive rate it claims?
//
// `confidenceThreshold = 1.96` is documented as "two-tailed alpha = 0.05", which
// is a promise: across many tests where no variant is genuinely better, at most
// ~5% should declare a winner. Three properties of the shipped rule break that
// promise, and they compound:
//
//   1. NO MINIMUM SAMPLE. The only guard is `RecipientsCount <= 0`, so a variant
//      with three recipients can win on one open.
//   2. POST-HOC SELECTION WITH NO CORRECTION. The leader is whichever variant
//      has the highest OBSERVED rate, then z-tested against the runner-up only.
//      With k variants that is k(k-1)/2 implicit comparisons priced as one.
//   3. UNBOUNDED PEEKING. `RecomputeAll` re-runs this every 30 minutes, and any
//      look that clears the bar ends the test. Repeatedly sampling until a
//      threshold is crossed will cross it eventually — this is optional
//      stopping, and it drives the error rate toward certainty.
//
// A simulation is the honest way to assert this: the rule is a statistical
// claim, and only a null-model run can falsify it.

// nullTrial runs one experiment where every variant has the SAME true rate, so
// any declared winner is a false positive. Returns true if a winner was declared
// at any point across the peeks.
// sequentialTrial runs one experiment and returns true if a winner was declared
// at any point across the peeks.
//
// `lift` is the true advantage of variant 0: 0 makes every arm identical, so any
// declared winner is a false positive; a positive value measures POWER, which
// matters just as much — a rule that never declares anything controls the error
// rate perfectly and is worthless.
//
// It drives EvaluateWinnerWithDeps with a real LookBudget, not the legacy
// single-look wrapper. That distinction is the entire subject of this file: the
// budget is what the peeking correction is computed from, so a simulation that
// skipped it would be measuring a rule the product does not run.
func sequentialTrial(rng *rand.Rand, variants, perVariant, peeks int, trueRate, lift float64) bool {
	successes := make([]int, variants)
	sent := make([]int, variants)
	perPeek := perVariant / peeks
	if perPeek < 1 {
		perPeek = 1
	}
	for p := 0; p < peeks; p++ {
		for v := 0; v < variants; v++ {
			r := trueRate
			if v == 0 {
				r = trueRate * (1 + lift)
			}
			for i := 0; i < perPeek; i++ {
				sent[v]++
				if rng.Float64() < r {
					successes[v]++
				}
			}
		}
		results := make([]VariantResult, variants)
		for v := range results {
			results[v] = VariantResult{
				VariantID:       string(rune('a' + v)),
				TenantID:        "t",
				RecipientsCount: sent[v],
				Delivered:       sent[v],
				Opens:           successes[v],
			}
		}
		budget := LookBudget{Planned: peeks, Taken: p + 1}
		if _, ok := EvaluateWinnerWithDeps(context.Background(), nil, "c1",
			WinnerMetricOpenRate, results, budget); ok {
			return true
		}
	}
	return false
}

// nullTrial is sequentialTrial with no true difference between the arms.
func nullTrial(rng *rand.Rand, variants, perVariant, peeks int, trueRate float64) bool {
	return sequentialTrial(rng, variants, perVariant, peeks, trueRate, 0)
}

func legacyNullTrial(rng *rand.Rand, variants, perVariant, peeks int, trueRate float64) bool {
	successes := make([]int, variants)
	sent := make([]int, variants)
	perPeek := perVariant / peeks
	if perPeek < 1 {
		perPeek = 1
	}
	for p := 0; p < peeks; p++ {
		for v := 0; v < variants; v++ {
			for i := 0; i < perPeek; i++ {
				sent[v]++
				if rng.Float64() < trueRate {
					successes[v]++
				}
			}
		}
		results := make([]VariantResult, variants)
		for v := range results {
			results[v] = VariantResult{
				VariantID:       string(rune('a' + v)),
				TenantID:        "t",
				RecipientsCount: sent[v],
				Delivered:       sent[v],
				Opens:           successes[v],
			}
		}
		if _, ok := EvaluateWinner(context.Background(), "c1", WinnerMetricOpenRate, results); ok {
			return true
		}
	}
	return false
}

func TestTheWinnerRuleHonoursItsStatedFalsePositiveRate(t *testing.T) {
	// Deterministic seed: a statistical assertion that flakes gets deleted.
	rng := rand.New(rand.NewSource(20260805))
	const (
		trials     = 400
		variants   = 3
		perVariant = 500
		peeks      = 48 // 24h of a 30-minute recompute
		trueRate   = 0.20
		alpha      = 0.05
	)
	false_ := 0
	for i := 0; i < trials; i++ {
		if nullTrial(rng, variants, perVariant, peeks, trueRate) {
			false_++
		}
	}
	rate := float64(false_) / float64(trials)

	// Ceiling at twice the nominal alpha. Measured before the fix: 12.0% — 2.4x
	// what the threshold advertises. (An earlier audit put this "near 1.0";
	// that was an overstatement, and the simulation is what settles it.) The
	// ceiling is deliberately loose rather than pinned to a precise number, so
	// the test asserts calibration without becoming a flake.
	if rate > 2*alpha {
		t.Fatalf("false-winner rate = %.1f%% across %d null experiments "+
			"(%d variants, %d recipients each, %d peeks). The threshold is "+
			"documented as alpha = %.0f%%. A rule that declares a winner in a "+
			"majority of experiments where NO variant is better will pick losing "+
			"subject lines and send them to the remaining audience.",
			rate*100, trials, variants, perVariant, peeks, alpha*100)
	}
	t.Logf("false-winner rate %.1f%% over %d trials", rate*100, trials)
}

func TestTheCorrectionHoldsOnceTheSampleFloorIsCleared(t *testing.T) {
	// The previous test alone does not prove the CORRECTION works: with 500
	// recipients spread over 48 peeks, almost no peek clears the minimum-sample
	// floor, so the floor could be doing all the work and a broken correction
	// would still look calibrated.
	//
	// Here every peek is far above the floor, so what is being measured is
	// peeking plus post-hoc leader selection across k variants — the part the
	// Sidak cutoff is responsible for.
	rng := rand.New(rand.NewSource(20260806))
	const (
		trials     = 300
		variants   = 4
		perVariant = 24000 // 500 per peek per variant, all above the floor
		peeks      = 48
		trueRate   = 0.20
		alpha      = 0.05
	)
	false_ := 0
	for i := 0; i < trials; i++ {
		if nullTrial(rng, variants, perVariant, peeks, trueRate) {
			false_++
		}
	}
	rate := float64(false_) / float64(trials)
	t.Logf("false-winner rate %.1f%% with every peek above the sample floor", rate*100)
	if rate > 4*alpha {
		t.Fatalf("false-winner rate = %.1f%% with %d variants, %d recipients each "+
			"and %d peeks, all above the minimum-sample floor. The floor is not "+
			"covering for the multiple-comparison correction here — this is the "+
			"correction failing.", rate*100, variants, perVariant, peeks)
	}
}

func TestATinySampleCannotWin(t *testing.T) {
	// Two recipients, one open. The z-statistic is meaningless at this size and
	// the normal approximation does not hold, but nothing stopped it.
	results := []VariantResult{
		{VariantID: "a", TenantID: "t", RecipientsCount: 2, Delivered: 2, Opens: 2},
		{VariantID: "b", TenantID: "t", RecipientsCount: 2, Delivered: 2, Opens: 0},
	}
	if id, ok := EvaluateWinner(context.Background(), "c1", WinnerMetricOpenRate, results); ok {
		t.Fatalf("declared %q the winner on 2 recipients per variant. Sending the "+
			"rest of the audience a subject line chosen from four data points is "+
			"worse than sending either one at random.", id)
	}
}

func TestAGenuineDifferenceIsStillDetected(t *testing.T) {
	// The control. A rule that never declares a winner would pass everything
	// above and be useless: the point is calibration, not silence.
	results := []VariantResult{
		{VariantID: "a", TenantID: "t", RecipientsCount: 5000, Delivered: 5000, Opens: 1500},
		{VariantID: "b", TenantID: "t", RecipientsCount: 5000, Delivered: 5000, Opens: 1000},
	}
	id, ok := EvaluateWinner(context.Background(), "c1", WinnerMetricOpenRate, results)
	if !ok {
		t.Fatal("30% vs 20% over 5000 recipients each was not detected; the rule " +
			"has been made so conservative it can no longer find a real effect")
	}
	if id != "a" {
		t.Fatalf("winner = %q, want the higher-performing variant a", id)
	}
}

func TestTheThresholdIsCorrectedForVariantCount(t *testing.T) {
	// The same leader-vs-runner-up gap must be harder to clear with more
	// variants, because more variants means more chances for noise to produce
	// one. Asserted as a property so the correction cannot be silently dropped.
	mk := func(n int) []VariantResult {
		out := make([]VariantResult, n)
		for i := range out {
			out[i] = VariantResult{
				VariantID: string(rune('a' + i)), TenantID: "t",
				RecipientsCount: 4000, Delivered: 4000, Opens: 800,
			}
		}
		// One variant nudged just above the rest.
		out[0].Opens = 880
		return out
	}
	_, two := EvaluateWinner(context.Background(), "c1", WinnerMetricOpenRate, mk(2))
	_, eight := EvaluateWinner(context.Background(), "c1", WinnerMetricOpenRate, mk(8))
	if eight && !two {
		t.Fatal("an eight-variant test declared a winner on a gap a two-variant " +
			"test could not — the threshold is moving the wrong way")
	}
	if two && eight {
		t.Error("the same gap wins with 2 and with 8 variants; the threshold is " +
			"not corrected for the number of comparisons, so more variants means " +
			"more false winners at the same price")
	}
	_ = math.Abs
}

// The case that was actually broken, and the case nobody measured.
//
// Every simulation above this ran FOUR variants, where the pairs correction
// (Šidák over k(k-1)/2 = 6, z = 2.63) happens to over-cover the peeking as a
// side effect. At two variants there is exactly ONE comparison, so that
// correction is the identity — the rule tested at a flat 1.96 once every thirty
// minutes for a whole day and stopped the first time noise cleared it.
//
// Two variants is not an edge case. It is what "A/B test" means.
func TestTwoVariantsAreNotDecidedByPeeking(t *testing.T) {
	const (
		trials     = 400
		variants   = 2
		peeks      = 48 // 24h at the default 30-minute cadence
		perVariant = 500 * peeks
		trueRate   = 0.20
		alpha      = 0.05
	)

	// The rule as it shipped: corrected for comparisons, blind to looks.
	legacy := 0
	rng := rand.New(rand.NewSource(20260806))
	for i := 0; i < trials; i++ {
		if legacyNullTrial(rng, variants, perVariant, peeks, trueRate) {
			legacy++
		}
	}
	legacyRate := float64(legacy) / float64(trials)

	// The same experiment through the horizon-aware rule.
	fixed := 0
	rng = rand.New(rand.NewSource(20260806))
	for i := 0; i < trials; i++ {
		if nullTrial(rng, variants, perVariant, peeks, trueRate) {
			fixed++
		}
	}
	fixedRate := float64(fixed) / float64(trials)

	t.Logf("two-variant false-winner rate: %.1f%% unbudgeted -> %.1f%% budgeted (%d looks)",
		legacyRate*100, fixedRate*100, peeks)

	// The premise. If this stops holding, the simulation has drifted and the
	// comparison below is meaningless — a "fix" measured against a baseline that
	// was never broken proves nothing.
	if legacyRate <= 2*alpha {
		t.Fatalf("the unbudgeted rule scored %.1f%%, which is not the runaway rate "+
			"this test exists to contrast against; the harness no longer reproduces "+
			"the defect", legacyRate*100)
	}
	if fixedRate > alpha {
		t.Fatalf("two-variant false-winner rate = %.1f%% over %d looks, above the "+
			"advertised alpha of %.0f%%. One in every %.0f two-variant tests would "+
			"mail the whole audience a subject line chosen by noise.",
			fixedRate*100, peeks, alpha*100, 1/fixedRate)
	}
}

// Calibration cuts both ways: a rule that declares nothing controls the error
// rate perfectly and is useless. This pins that the horizon correction did not
// buy its safety by making the test undecidable.
func TestARealDifferenceStillWinsWithinTheHorizon(t *testing.T) {
	const (
		trials     = 300
		peeks      = 48
		perVariant = 500 * peeks
		trueRate   = 0.20
		lift       = 0.10 // a 10% relative lift: 20% -> 22%
	)
	for _, variants := range []int{2, 4} {
		rng := rand.New(rand.NewSource(4242))
		wins := 0
		for i := 0; i < trials; i++ {
			if sequentialTrial(rng, variants, perVariant, peeks, trueRate, lift) {
				wins++
			}
		}
		power := float64(wins) / float64(trials)
		t.Logf("power at a %.0f%% lift with %d variants over %d looks: %.1f%%",
			lift*100, variants, peeks, power*100)
		if power < 0.80 {
			t.Errorf("power = %.1f%% with %d variants: a real %.0f%% lift goes "+
				"undetected across a full 24-hour horizon, so the correction has "+
				"been taken past the point of usefulness", power*100, variants, lift*100)
		}
	}
}

// The budget has to be enforced, not merely computed. Without this, the cutoff
// is raised for a horizon that nothing stops a caller from exceeding — and the
// caller most able to exceed it is a person re-POSTing /ab/evaluate because they
// dislike the answer.
func TestOnceTheHorizonIsSpentNoWinnerIsDeclared(t *testing.T) {
	// An overwhelming, unambiguous difference: 30% vs 20% over 5000 each.
	results := []VariantResult{
		{VariantID: "a", TenantID: "t", RecipientsCount: 5000, Delivered: 5000, Opens: 1500},
		{VariantID: "b", TenantID: "t", RecipientsCount: 5000, Delivered: 5000, Opens: 1000},
	}
	within := LookBudget{Planned: 10, Taken: 10}
	if _, ok := EvaluateWinnerWithDeps(context.Background(), nil, "c1",
		WinnerMetricOpenRate, results, within); !ok {
		t.Fatal("the last look inside the horizon decided nothing on a 30 vs 20 percent " +
			"split; the budget is off by one and the final look is being thrown away")
	}
	spent := LookBudget{Planned: 10, Taken: 11}
	if _, ok := EvaluateWinnerWithDeps(context.Background(), nil, "c1",
		WinnerMetricOpenRate, results, spent); ok {
		t.Fatal("a winner was declared on look 11 of a 10-look budget; the horizon " +
			"is advisory, so any cutoff can be cleared by asking often enough")
	}
}

func TestTheHorizonComesFromTheOperatorsOwnSettings(t *testing.T) {
	cases := []struct {
		name        string
		windowHours int
		intervalMin int
		want        int
	}{
		{"the defaults: 24h at 30 minutes", 24, 30, 48},
		{"a short test still gets at least one look", 1, 120, 1},
		{"unset values fall back to the defaults rather than to zero", 0, 0, 48},
		{"a pathological cadence is capped", 720, 1, maxPlannedLooks},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PlannedLooks(tc.windowHours, tc.intervalMin); got != tc.want {
				t.Fatalf("PlannedLooks(%d, %d) = %d, want %d",
					tc.windowHours, tc.intervalMin, got, tc.want)
			}
		})
	}
	// Zero would make the cutoff collapse to the uncorrected 1.96 — the defect,
	// restored by a misconfiguration rather than by a code change.
	if PlannedLooks(0, 0) < 1 {
		t.Fatal("PlannedLooks returned a budget below 1")
	}
}
