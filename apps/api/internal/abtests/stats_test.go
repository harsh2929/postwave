// SPDX-License-Identifier: AGPL-3.0-only
package abtests

import (
	"math"
	"math/rand"
	"testing"
)

func TestTwoProportionTest_BasicCounts(t *testing.T) {
	// 220/500 vs 270/500 -> pA=0.44, pB=0.54, lift +22.7%, very significant.
	res := TwoProportionTest(
		VariantCounts{Sent: 500, Hits: 220},
		VariantCounts{Sent: 500, Hits: 270},
	)
	if math.Abs(res.PA-0.44) > 1e-9 {
		t.Fatalf("pA=%v, want 0.44", res.PA)
	}
	if math.Abs(res.PB-0.54) > 1e-9 {
		t.Fatalf("pB=%v, want 0.54", res.PB)
	}
	if res.ZScore <= 0 {
		t.Fatalf("zscore should be positive when B beats A, got %v", res.ZScore)
	}
	if res.PValue >= 0.01 {
		t.Fatalf("expected p<0.01 for clear lift, got %v", res.PValue)
	}
	if res.LiftPercent < 22 || res.LiftPercent > 23 {
		t.Fatalf("lift=%v, want ~22.7", res.LiftPercent)
	}
}

func TestTwoProportionTest_NoDifference(t *testing.T) {
	// Identical proportions -> z=0, p=1, lift=0.
	res := TwoProportionTest(
		VariantCounts{Sent: 500, Hits: 250},
		VariantCounts{Sent: 500, Hits: 250},
	)
	if res.ZScore != 0 {
		t.Fatalf("z=%v, want 0", res.ZScore)
	}
	if math.Abs(res.PValue-1) > 1e-9 {
		t.Fatalf("p=%v, want 1", res.PValue)
	}
	if res.LiftPercent != 0 {
		t.Fatalf("lift=%v, want 0", res.LiftPercent)
	}
}

func TestTwoProportionTest_EmptySamples(t *testing.T) {
	// Defensive: zero sent on either side returns the zero struct.
	res := TwoProportionTest(VariantCounts{Sent: 0, Hits: 0}, VariantCounts{Sent: 100, Hits: 50})
	if res.PA != 0 || res.PB != 0 || res.ZScore != 0 {
		t.Fatalf("expected zero values, got %+v", res)
	}
}

func TestTwoProportionTest_PValueTwoTailed(t *testing.T) {
	// Borderline-significant: 200/1000 vs 230/1000 ~ z≈1.66, p≈0.097
	res := TwoProportionTest(
		VariantCounts{Sent: 1000, Hits: 200},
		VariantCounts{Sent: 1000, Hits: 230},
	)
	if res.PValue < 0.05 || res.PValue > 0.15 {
		t.Fatalf("p=%v, expected ~0.10", res.PValue)
	}
}

func TestBayesianPosterior_DeterministicSeed(t *testing.T) {
	// Same seed -> same result. Two seeded RNGs must agree.
	a := VariantCounts{Sent: 500, Hits: 220}
	b := VariantCounts{Sent: 500, Hits: 270}
	r1 := bayesianPosteriorWithRNG(a, b, rand.New(rand.NewSource(42)))
	r2 := bayesianPosteriorWithRNG(a, b, rand.New(rand.NewSource(42)))
	if r1.ProbBBetter != r2.ProbBBetter {
		t.Fatalf("deterministic seed mismatch: %v vs %v", r1.ProbBBetter, r2.ProbBBetter)
	}
	if r1.CredibleInterval95 != r2.CredibleInterval95 {
		t.Fatalf("CI mismatch: %+v vs %+v", r1.CredibleInterval95, r2.CredibleInterval95)
	}
}

func TestBayesianPosterior_BBetterHighProb(t *testing.T) {
	// Strong lift: B should win nearly all the time.
	a := VariantCounts{Sent: 500, Hits: 220}
	b := VariantCounts{Sent: 500, Hits: 290}
	r := bayesianPosteriorWithRNG(a, b, rand.New(rand.NewSource(7)))
	if r.ProbBBetter < 0.99 {
		t.Fatalf("expected P(B>A) ~0.99, got %v", r.ProbBBetter)
	}
	if r.CredibleInterval95[0] >= r.CredibleInterval95[1] {
		t.Fatalf("CI bounds out of order: %+v", r.CredibleInterval95)
	}
	// CI on the difference should not bracket zero (clear winner).
	if r.CredibleInterval95[0] <= 0 {
		t.Fatalf("CI low bound %v should be > 0 for a clear B-better result", r.CredibleInterval95[0])
	}
}

func TestBayesianPosterior_TiedDataBracketsZero(t *testing.T) {
	// Identical data: P(B>A) ~ 0.5, CI brackets zero.
	a := VariantCounts{Sent: 500, Hits: 250}
	b := VariantCounts{Sent: 500, Hits: 250}
	r := bayesianPosteriorWithRNG(a, b, rand.New(rand.NewSource(99)))
	if math.Abs(r.ProbBBetter-0.5) > 0.05 {
		t.Fatalf("expected P(B>A) ~0.5, got %v", r.ProbBBetter)
	}
	if !(r.CredibleInterval95[0] <= 0 && r.CredibleInterval95[1] >= 0) {
		t.Fatalf("expected CI to bracket 0, got %+v", r.CredibleInterval95)
	}
}

func TestBayesianPosterior_PriorIsBeta11(t *testing.T) {
	// Posterior alpha should be 1+hits, beta should be 1+sent-hits.
	r := bayesianPosteriorWithRNG(
		VariantCounts{Sent: 100, Hits: 30},
		VariantCounts{Sent: 100, Hits: 40},
		rand.New(rand.NewSource(1)),
	)
	if r.PosteriorA.Alpha != 31 || r.PosteriorA.Beta != 71 {
		t.Fatalf("posteriorA=%+v, want {31,71}", r.PosteriorA)
	}
	if r.PosteriorB.Alpha != 41 || r.PosteriorB.Beta != 61 {
		t.Fatalf("posteriorB=%+v, want {41,61}", r.PosteriorB)
	}
}

func TestBonferroniAlpha(t *testing.T) {
	if BonferroniAlpha(0.05, 1) != 0.05 {
		t.Fatalf("single comparison shouldn't correct")
	}
	if BonferroniAlpha(0.05, 0) != 0.05 {
		t.Fatalf("zero comparisons -> uncorrected")
	}
	got := BonferroniAlpha(0.05, 3)
	if math.Abs(got-(0.05/3)) > 1e-12 {
		t.Fatalf("3-way correction = %v, want %v", got, 0.05/3)
	}
	got = BonferroniAlpha(0.05, 4)
	if math.Abs(got-0.0125) > 1e-12 {
		t.Fatalf("4-way correction = %v, want 0.0125", got)
	}
}

func TestPhi(t *testing.T) {
	// Smoke-test Phi against well-known values.
	if math.Abs(phi(0)-0.5) > 1e-9 {
		t.Fatalf("Phi(0)=%v, want 0.5", phi(0))
	}
	if math.Abs(phi(1.96)-0.975) > 1e-3 {
		t.Fatalf("Phi(1.96)=%v, want ~0.975", phi(1.96))
	}
	if math.Abs(phi(-1.96)-0.025) > 1e-3 {
		t.Fatalf("Phi(-1.96)=%v, want ~0.025", phi(-1.96))
	}
}
