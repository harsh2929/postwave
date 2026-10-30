// SPDX-License-Identifier: AGPL-3.0-only
package predictive_clv

import (
	"math"
	"testing"
)

// canonicalCDNOWParams are the parameters Fader, Hardie & Lee (2005)
// fit to the CDNOW dataset — the reference values every BG/NBD
// implementation (R's BTYD, Python's lifetimes) is validated against.
var canonicalCDNOWParams = Params{R: 0.243, Alpha: 4.414, A: 0.793, B: 2.426}

// TestConditionalExpectedTransactions_PublishedReference checks the
// worked example from the BG/NBD literature: a CDNOW customer with
// x=2 repeat transactions, whose last repeat was at t_x=30.43 weeks,
// observed for T=38.86 weeks, has a conditional expectation of ~1.226
// transactions over the next 39 weeks under the canonical CDNOW fit.
func TestConditionalExpectedTransactions_PublishedReference(t *testing.T) {
	got := ConditionalExpectedTransactions(canonicalCDNOWParams, 39, 2, 30.43, 38.86)
	want := 1.226
	if diff := math.Abs(got - want); diff > 0.01 {
		t.Fatalf("ConditionalExpectedTransactions = %.6f, want ~%.3f (diff %.6f > 0.01 tolerance)", got, want, diff)
	}
}

// TestConditionalExpectedTransactions_RelativeOrdering checks the
// conditional expectation against the same-params/same-horizon
// published reference customer (x=2, tx=30.43, T=38.86 -> ~1.226 over
// 39 weeks; see TestConditionalExpectedTransactions_PublishedReference)
// by domain-reasoned bounds rather than a second magic number this
// implementation can't independently verify against a published
// source:
//
//   - A customer who never repeated (x=0) should have a *lower*
//     forward expectation than the reference customer, but strictly
//     positive (the model never rules a customer fully "dead").
//   - A customer with far more repeats, whose last one was right at
//     the edge of the observation window (maximally "engaged and
//     recent"), should have a materially *higher* forward expectation
//     than the reference customer.
func TestConditionalExpectedTransactions_RelativeOrdering(t *testing.T) {
	const horizon = 39.0
	reference := ConditionalExpectedTransactions(canonicalCDNOWParams, horizon, 2, 30.43, 38.86)

	zeroRepeat := ConditionalExpectedTransactions(canonicalCDNOWParams, horizon, 0, 0, 38.86)
	if !(zeroRepeat > 0 && zeroRepeat < reference) {
		t.Fatalf("zero-repeat customer expectation = %v, want in (0, %v)", zeroRepeat, reference)
	}

	highFrequencyRecent := ConditionalExpectedTransactions(canonicalCDNOWParams, horizon, 10, 38, 38.86)
	if !(highFrequencyRecent > reference) {
		t.Fatalf("high-frequency recent customer expectation = %v, want > reference %v", highFrequencyRecent, reference)
	}
}

// TestPAlive_ZeroFrequencyIsAlwaysAlive asserts the well-known BG/NBD
// limiting property: a customer with x==0 repeat transactions is always
// scored P(alive)==1, regardless of T or params.
func TestPAlive_ZeroFrequencyIsAlwaysAlive(t *testing.T) {
	for _, T := range []float64{1, 10, 100, 1000} {
		got := PAlive(canonicalCDNOWParams, 0, 0, T)
		if got != 1 {
			t.Errorf("PAlive(x=0, T=%v) = %v, want 1", T, got)
		}
	}
}

// TestPAlive_MonotonicInRecency checks that, holding x and T fixed,
// P(alive) is non-decreasing in t_x: a customer whose last repeat
// transaction is more recent (closer to T) should never look LESS
// likely to still be alive than one whose last repeat was further back.
func TestPAlive_MonotonicInRecency(t *testing.T) {
	const x, T = 5.0, 52.0
	prev := -1.0
	for tx := 0.0; tx <= T; tx += 2.0 {
		got := PAlive(canonicalCDNOWParams, x, tx, T)
		if got < prev-1e-9 {
			t.Fatalf("PAlive not monotonic in recency: tx=%v got %v < previous %v", tx, got, prev)
		}
		if got < 0 || got > 1 {
			t.Fatalf("PAlive out of [0,1] range: %v at tx=%v", got, tx)
		}
		prev = got
	}
}

// TestPAlive_MonotonicInFrequency checks that, holding recency ratio
// (tx == T, i.e. "last seen right now") and T fixed, higher observed
// frequency x does not decrease P(alive) — more repeat purchases by
// the time of the last one is (weakly) reassuring, not damning.
func TestPAlive_MonotonicInFrequency(t *testing.T) {
	const T = 52.0
	prev := -1.0
	for x := 1.0; x <= 20; x++ {
		got := PAlive(canonicalCDNOWParams, x, T, T)
		if got < prev-1e-9 {
			t.Fatalf("PAlive not monotonic in frequency at tx=T: x=%v got %v < previous %v", x, got, prev)
		}
		prev = got
	}
}

// TestLnGamma_KnownValues checks lnGamma against exact values computed
// from factorials (Gamma(n) = (n-1)!) and a couple of well-known
// non-integer identities.
func TestLnGamma_KnownValues(t *testing.T) {
	cases := []struct {
		x, want float64
	}{
		{1, 0},                              // Gamma(1) = 0! = 1 -> ln = 0
		{2, 0},                              // Gamma(2) = 1! = 1 -> ln = 0
		{5, math.Log(24)},                   // Gamma(5) = 4! = 24
		{10, math.Log(362880)},              // Gamma(10) = 9! = 362880
		{0.5, math.Log(math.Sqrt(math.Pi))}, // Gamma(1/2) = sqrt(pi)
	}
	for _, tc := range cases {
		got := lnGamma(tc.x)
		if diff := math.Abs(got - tc.want); diff > 1e-9 {
			t.Errorf("lnGamma(%v) = %v, want %v (diff %v)", tc.x, got, tc.want, diff)
		}
	}
}

// TestLogBeta_Symmetry checks B(a,b) == B(b,a), a basic identity of the
// Beta function that a correct lnGamma-based implementation must
// preserve exactly (up to floating point).
func TestLogBeta_Symmetry(t *testing.T) {
	pairs := [][2]float64{{1, 1}, {0.5, 3}, {2.7, 9.1}, {100, 0.3}}
	for _, p := range pairs {
		ab := logBeta(p[0], p[1])
		ba := logBeta(p[1], p[0])
		if diff := math.Abs(ab - ba); diff > 1e-9 {
			t.Errorf("logBeta(%v,%v)=%v != logBeta(%v,%v)=%v", p[0], p[1], ab, p[1], p[0], ba)
		}
	}
}

// TestHyp2F1_ZeroArgument checks the trivial identity 2F1(a,b;c;0) = 1
// for any a,b,c (the series has only its leading 1 term when z=0).
func TestHyp2F1_ZeroArgument(t *testing.T) {
	got := hyp2f1(3.7, 1.2, 5.5, 0)
	if got != 1 {
		t.Fatalf("hyp2f1(...,0) = %v, want 1", got)
	}
}

// TestHyp2F1_ClosedFormWhenCEqualsB checks the identity
// 2F1(a,b;b;z) = (1-z)^(-a), which holds for any a and any b (the c==b
// case degenerates the series into a binomial expansion). This
// independently validates the series/ratio implementation without
// relying on the BG/NBD-specific reference values.
func TestHyp2F1_ClosedFormWhenCEqualsB(t *testing.T) {
	cases := []struct{ a, b, z float64 }{
		{2, 3, 0.4},
		{0.5, 7, 0.2},
		{5, 1.5, 0.85},
		{1.3, 2.2, -0.6}, // hyp2f1 series also converges for negative z
	}
	for _, tc := range cases {
		got := hyp2f1(tc.a, tc.b, tc.b, tc.z)
		want := math.Pow(1-tc.z, -tc.a)
		if diff := math.Abs(got - want); diff > 1e-6*math.Abs(want)+1e-9 {
			t.Errorf("hyp2f1(%v,%v;%v;%v) = %v, want %v (diff %v)", tc.a, tc.b, tc.b, tc.z, got, want, diff)
		}
	}
}

// TestHyp2F1_ConvergesNearUnitBoundary exercises the slow-convergence
// regime (z close to 1, which ConditionalExpectedTransactions reaches
// as the forecast horizon t grows much larger than alpha+T) and checks
// the result stays finite and matches the c==b closed form there too.
func TestHyp2F1_ConvergesNearUnitBoundary(t *testing.T) {
	a, b, z := 1.8, 4.0, 0.999
	got := hyp2f1(a, b, b, z)
	want := math.Pow(1-z, -a)
	if math.IsNaN(got) || math.IsInf(got, 0) {
		t.Fatalf("hyp2f1 near z=1 produced non-finite result: %v", got)
	}
	if diff := math.Abs(got-want) / want; diff > 1e-3 {
		t.Fatalf("hyp2f1 near z=1 = %v, want ~%v (relative diff %v)", got, want, diff)
	}
}

// TestConditionalExpectedTransactions_MonotonicInHorizon checks that
// the expected transaction count is non-decreasing as the forecast
// horizon t grows — a customer can only accumulate more expected
// purchases over a longer future window, never fewer.
func TestConditionalExpectedTransactions_MonotonicInHorizon(t *testing.T) {
	prev := -1.0
	for _, horizon := range []float64{1, 5, 13, 26, 52, 104} {
		got := ConditionalExpectedTransactions(canonicalCDNOWParams, horizon, 2, 30.43, 38.86)
		if got < prev {
			t.Fatalf("expected transactions decreased as horizon grew: horizon=%v got=%v prev=%v", horizon, got, prev)
		}
		prev = got
	}
}

// TestConditionalExpectedTransactions_ZeroHorizon checks the t<=0
// boundary explicitly returns zero rather than an artifact of the
// hypergeometric series at z=0 combined with floating point noise.
func TestConditionalExpectedTransactions_ZeroHorizon(t *testing.T) {
	if got := ConditionalExpectedTransactions(canonicalCDNOWParams, 0, 2, 30.43, 38.86); got != 0 {
		t.Fatalf("ConditionalExpectedTransactions(t=0) = %v, want 0", got)
	}
	if got := ConditionalExpectedTransactions(canonicalCDNOWParams, -5, 2, 30.43, 38.86); got != 0 {
		t.Fatalf("ConditionalExpectedTransactions(t<0) = %v, want 0", got)
	}
}

// TestConditionalExpectedTransactions_ASingularityIsHandled exercises
// the a==1 removable-singularity guard directly, checking the function
// still returns a finite, sane (non-negative, small relative to
// neighboring a values) result rather than NaN/Inf.
func TestConditionalExpectedTransactions_ASingularityIsHandled(t *testing.T) {
	p := Params{R: 0.5, Alpha: 3, A: 1.0, B: 2}
	got := ConditionalExpectedTransactions(p, 39, 2, 30, 38.86)
	if math.IsNaN(got) || math.IsInf(got, 0) {
		t.Fatalf("ConditionalExpectedTransactions at a==1 produced non-finite result: %v", got)
	}
	if got < 0 {
		t.Fatalf("ConditionalExpectedTransactions at a==1 negative: %v", got)
	}
	// Should be close to evaluating at a=1.0001 and a=0.9999 (continuity).
	pHi := p
	pHi.A = 1.0001
	pLo := p
	pLo.A = 0.9999
	gotHi := ConditionalExpectedTransactions(pHi, 39, 2, 30, 38.86)
	gotLo := ConditionalExpectedTransactions(pLo, 39, 2, 30, 38.86)
	if math.Abs(gotHi-gotLo) > 0.05 {
		t.Fatalf("discontinuity around a=1: a=0.9999 -> %v, a=1.0001 -> %v", gotLo, gotHi)
	}
}

// TestEstimatedCLV_ScalesWithMonetaryValue checks EstimatedCLV is a
// simple linear multiplier of the conditional expected transaction
// count, and that doubling the average order value doubles the CLV.
func TestEstimatedCLV_ScalesWithMonetaryValue(t *testing.T) {
	s := CustomerSummary{X: 2, Tx: 30.43, T: 38.86}
	base := EstimatedCLV(canonicalCDNOWParams, s, 39, 5000)
	doubled := EstimatedCLV(canonicalCDNOWParams, s, 39, 10000)
	if diff := math.Abs(doubled - 2*base); diff > 1e-6 {
		t.Fatalf("EstimatedCLV not linear in avgMonetaryValue: base=%v doubled=%v", base, doubled)
	}
	wantBase := ConditionalExpectedTransactions(canonicalCDNOWParams, 39, s.X, s.Tx, s.T) * 5000
	if diff := math.Abs(base - wantBase); diff > 1e-9 {
		t.Fatalf("EstimatedCLV = %v, want %v", base, wantBase)
	}
}

// TestLogLikelihood_WeightedEqualsReplicated checks that LogLikelihood
// on a summary with Weight=N produces the same total as N unweighted
// copies of that same row — the aggregation path a real per-tenant
// training job would use (grouping identical (x, tx, T) rows) must
// agree with the naive per-customer path.
func TestLogLikelihood_WeightedEqualsReplicated(t *testing.T) {
	weighted := []CustomerSummary{{X: 3, Tx: 20, T: 40, Weight: 7}}
	replicated := make([]CustomerSummary, 7)
	for i := range replicated {
		replicated[i] = CustomerSummary{X: 3, Tx: 20, T: 40}
	}
	gotW := LogLikelihood(canonicalCDNOWParams, weighted)
	gotR := LogLikelihood(canonicalCDNOWParams, replicated)
	if diff := math.Abs(gotW - gotR); diff > 1e-9 {
		t.Fatalf("weighted LogLikelihood = %v, replicated = %v (diff %v)", gotW, gotR, diff)
	}
}
