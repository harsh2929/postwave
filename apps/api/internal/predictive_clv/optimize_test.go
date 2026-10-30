// SPDX-License-Identifier: AGPL-3.0-only
package predictive_clv

import (
	"math"
	"math/rand"
	"testing"
)

// --- Nelder-Mead sanity on textbook test functions -------------------

// TestNelderMead_Sphere checks convergence to the trivial minimum of
// f(x) = sum(x_i^2) at the origin from an off-origin start.
func TestNelderMead_Sphere(t *testing.T) {
	f := func(x []float64) float64 {
		s := 0.0
		for _, v := range x {
			s += v * v
		}
		return s
	}
	x, fx, _ := NelderMead(f, []float64{3, -2, 5}, NelderMeadOptions{MaxIterations: 5000, Tolerance: 1e-14})
	if fx > 1e-6 {
		t.Fatalf("Sphere minimum not found: f(x)=%v at x=%v", fx, x)
	}
	for i, v := range x {
		if math.Abs(v) > 1e-3 {
			t.Errorf("x[%d] = %v, want ~0", i, v)
		}
	}
}

// TestNelderMead_Rosenbrock checks convergence on the classic
// Rosenbrock "banana" function, a much harder non-convex test case
// with minimum 0 at (1,1) — a reasonable proxy for how well the
// implementation navigates the curved, elongated log-likelihood ridges
// BG/NBD fitting produces in practice.
func TestNelderMead_Rosenbrock(t *testing.T) {
	f := func(x []float64) float64 {
		a, b := x[0], x[1]
		return (1-a)*(1-a) + 100*(b-a*a)*(b-a*a)
	}
	x, fx, iters := NelderMead(f, []float64{-1.2, 1}, NelderMeadOptions{MaxIterations: 20000, Tolerance: 1e-16})
	if fx > 1e-4 {
		t.Fatalf("Rosenbrock minimum not found after %d iterations: f(x)=%v at x=%v", iters, fx, x)
	}
	if math.Abs(x[0]-1) > 0.05 || math.Abs(x[1]-1) > 0.05 {
		t.Errorf("x = %v, want ~[1,1]", x)
	}
}

// --- Method-of-moments seed sanity ------------------------------------

// TestMethodOfMomentsSeed_ValidOnDegenerateInput checks the seed never
// produces an invalid (non-positive/NaN) Params even when every
// customer has x==0 (a real, common case: a brand-new tenant whose
// customers haven't repeat-purchased yet).
func TestMethodOfMomentsSeed_ValidOnDegenerateInput(t *testing.T) {
	summaries := []CustomerSummary{
		{X: 0, Tx: 0, T: 10},
		{X: 0, Tx: 0, T: 20},
		{X: 0, Tx: 0, T: 5},
	}
	seed := MethodOfMomentsSeed(summaries)
	if !seed.Valid() {
		t.Fatalf("seed not valid on degenerate all-zero input: %+v", seed)
	}
}

// TestMethodOfMomentsSeed_EmptyInput checks the empty-slice edge case
// also returns a valid Params rather than dividing by zero.
func TestMethodOfMomentsSeed_EmptyInput(t *testing.T) {
	seed := MethodOfMomentsSeed(nil)
	if !seed.Valid() {
		t.Fatalf("seed not valid on empty input: %+v", seed)
	}
}

// --- Simulation-based recovery test -----------------------------------
//
// generateBGNBDSample simulates customer histories directly from the
// BG/NBD generative process (Fader/Hardie/Lee 2005 sec. 2): draw a
// latent transaction rate lambda ~ Gamma(r, alpha) and a latent
// per-transaction dropout probability p ~ Beta(a, b) for each customer,
// then simulate a sequence of Exponential(lambda) inter-transaction
// waiting times, flipping a Bernoulli(p) "dies now" coin after each
// realized transaction, stopping either at the customer's death or at
// the observation horizon T. This is the same construction lifetimes'
// and BTYD's synthetic-data generators use, and is the standard way to
// validate that an MLE fitting routine recovers the generating
// parameters.
func generateBGNBDSample(rng *rand.Rand, p Params, T float64, n int) []CustomerSummary {
	out := make([]CustomerSummary, n)
	for i := 0; i < n; i++ {
		lambda := sampleGamma(rng, p.R, p.Alpha)
		dropoutP := sampleBeta(rng, p.A, p.B)

		var t, lastTx float64
		x := 0.0
		alive := true
		for alive {
			wait := rng.ExpFloat64() / lambda
			if t+wait >= T {
				break
			}
			t += wait
			x++
			lastTx = t
			if rng.Float64() < dropoutP {
				alive = false
			}
		}
		out[i] = CustomerSummary{X: x, Tx: lastTx, T: T}
	}
	return out
}

// sampleGamma draws from Gamma(shape, rate) via Marsaglia & Tsang
// (2000)'s method (shape>=1 case), boosted for shape<1 via the standard
// Gamma(shape+1) * U^(1/shape) transform.
func sampleGamma(rng *rand.Rand, shape, rate float64) float64 {
	if shape < 1 {
		u := rng.Float64()
		return sampleGamma(rng, shape+1, rate) * math.Pow(u, 1/shape)
	}
	d := shape - 1.0/3.0
	c := 1.0 / math.Sqrt(9*d)
	for {
		var x, v float64
		for {
			x = rng.NormFloat64()
			v = 1 + c*x
			if v > 0 {
				break
			}
		}
		v = v * v * v
		u := rng.Float64()
		if u < 1-0.0331*x*x*x*x {
			return d * v / rate
		}
		if math.Log(u) < 0.5*x*x+d*(1-v+math.Log(v)) {
			return d * v / rate
		}
	}
}

// sampleBeta draws from Beta(a, b) via the Gamma-ratio construction
// X/(X+Y), X~Gamma(a,1), Y~Gamma(b,1).
func sampleBeta(rng *rand.Rand, a, b float64) float64 {
	x := sampleGamma(rng, a, 1)
	y := sampleGamma(rng, b, 1)
	return x / (x + y)
}

// TestFitBGNBD_RecoversKnownParamsOnSyntheticData is the central
// optimizer-correctness test: simulate a large synthetic customer base
// from known (r, alpha, a, b), fit with FitBGNBD, and check both (a)
// the fit is at least as good, in log-likelihood terms, as the true
// generating parameters on that same sample (which is what MLE
// guarantees the optimizer found something close to a genuine optimum,
// independent of sampling noise) and (b) the recovered aggregate
// moments (mean transaction rate r/alpha, mean dropout probability
// a/(a+b)) are within a generous but non-trivial tolerance of the true
// ones.
func TestFitBGNBD_RecoversKnownParamsOnSyntheticData(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	truth := Params{R: 0.8, Alpha: 2.0, A: 0.5, B: 3.0}
	const T = 52.0
	const n = 4000

	summaries := generateBGNBDSample(rng, truth, T, n)

	result, err := FitBGNBD(summaries, FitOptions{MaxIterations: 4000})
	if err != nil {
		t.Fatalf("FitBGNBD error: %v", err)
	}
	if !result.Params.Valid() {
		t.Fatalf("fitted params not valid: %+v", result.Params)
	}

	// (a) MLE guarantee: the fit found by our optimizer must not be
	// worse (in log-likelihood, on this sample) than the true
	// generating parameters — a small slack accounts for Nelder-Mead
	// not reaching the exact numerical optimum.
	llTruth := LogLikelihood(truth, summaries)
	llFitted := LogLikelihood(result.Params, summaries)
	if llFitted < llTruth-1.0 {
		t.Errorf("fitted log-likelihood (%v) is worse than truth's (%v) by more than slack; optimizer did not converge", llFitted, llTruth)
	}

	// (b) Recovered aggregate moments should be in the right
	// ballpark. Individual (r,alpha) and (a,b) can trade off against
	// each other under MLE with finite samples (a classic BG/NBD
	// identifiability wrinkle), so we check the moments they jointly
	// determine rather than each raw parameter.
	trueRate := truth.R / truth.Alpha
	fittedRate := result.Params.R / result.Params.Alpha
	if relErr := math.Abs(fittedRate-trueRate) / trueRate; relErr > 0.35 {
		t.Errorf("recovered mean transaction rate r/alpha = %v, true = %v (relative error %v > 0.35)", fittedRate, trueRate, relErr)
	}

	trueDropout := truth.A / (truth.A + truth.B)
	fittedDropout := result.Params.A / (result.Params.A + result.Params.B)
	if diff := math.Abs(fittedDropout - trueDropout); diff > 0.15 {
		t.Errorf("recovered mean dropout probability a/(a+b) = %v, true = %v (abs diff %v > 0.15)", fittedDropout, trueDropout, diff)
	}
}

// TestFitBGNBD_EmptyInput checks the documented error path.
func TestFitBGNBD_EmptyInput(t *testing.T) {
	_, err := FitBGNBD(nil, FitOptions{})
	if err == nil {
		t.Fatal("expected error for empty summaries, got nil")
	}
	if got := reasonOf(err); got != RejectInvalidInput {
		t.Fatalf("empty summaries rejected as %q, want %q (error: %v)", got, RejectInvalidInput, err)
	}
}

// TestFitBGNBD_SeedOverrideIsUsed checks that an explicit FitOptions.Seed
// is honored as the starting point rather than silently falling back to
// MethodOfMomentsSeed (a regression this specific check guards against:
// it's easy to accidentally ignore a non-nil override when threading it
// through to the optimizer).
func TestFitBGNBD_SeedOverrideIsUsed(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	truth := Params{R: 0.6, Alpha: 3.0, A: 1.0, B: 2.0}
	summaries := generateBGNBDSample(rng, truth, 40, 1000)

	// A deliberately bad seed far from both the MoM seed and the
	// truth; if the override isn't wired through, the optimizer would
	// instead start from MethodOfMomentsSeed(summaries), which for
	// this sample lands much closer to the truth and would very
	// unlikely happen to land at exactly this same optimum via a
	// different path within so few iterations.
	badSeed := Params{R: 20, Alpha: 200, A: 20, B: 0.05}
	resultDefault, err := FitBGNBD(summaries, FitOptions{MaxIterations: 300})
	if err != nil {
		t.Fatalf("FitBGNBD (default seed) error: %v", err)
	}
	resultOverride, err := FitBGNBD(summaries, FitOptions{MaxIterations: 300, Seed: &badSeed})
	// The well-seeded run converges inside the budget (the nil error above
	// says so). The bad seed cannot, and FitBGNBD rejects it as not
	// converged while still reporting the best point it reached. A
	// different outcome under the same budget is itself proof that the
	// override changed the starting point.
	if got := reasonOf(err); got != RejectNotConverged {
		t.Fatalf("FitBGNBD (override seed) error = %v, want a %q rejection", err, RejectNotConverged)
	}
	if resultOverride.Converged || resultOverride.Iterations != 300 {
		t.Fatalf("override run reports Converged=%v after %d iterations, want false after 300",
			resultOverride.Converged, resultOverride.Iterations)
	}

	// With a deliberately-bad seed and a tight iteration budget, the
	// override run should not have converged as far as the
	// well-seeded default run — proving the seed override actually
	// changed the optimizer's trajectory.
	llDefault := LogLikelihood(resultDefault.Params, summaries)
	llOverride := LogLikelihood(resultOverride.Params, summaries)
	if llOverride > llDefault {
		t.Errorf("override-seeded run (ll=%v) outperformed default-seeded run (ll=%v) despite starting from a deliberately bad point + tight iteration budget; is Seed actually wired through?", llOverride, llDefault)
	}
}
