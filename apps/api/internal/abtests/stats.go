// SPDX-License-Identifier: AGPL-3.0-only
//
// Package abtests / stats.go — operator-facing significance testing for
// the A/B results reader. The functions here are pure Go and do not
// touch the DB; they take per-variant counts and return human-readable
// frequentist + Bayesian summaries.
//
// Why two methods side-by-side: frequentist p-values are familiar but
// answer the wrong question for marketers ("if there were no
// difference, how surprising are these data?"). Bayesian P(B > A) is
// the answer they actually want ("how confident am I that B beats
// A?"). We compute both and let the operator pick a tab in the UI.

package abtests

import (
	"math"
	"math/rand"
	"sort"
)

// VariantCounts is the (sent, hits) pair for a single variant under a
// given metric. Hits = opens / clicks / replies depending on the
// metric the operator chose.
type VariantCounts struct {
	Sent int `json:"sent"`
	Hits int `json:"hits"`
}

// ProportionTest is the result of a frequentist two-proportion z-test
// comparing variant A (control) vs variant B (challenger).
//
// Sign convention: Difference and LiftPercent are positive when B
// beats A; ZScore is signed accordingly.
type ProportionTest struct {
	A           VariantCounts `json:"a"`
	B           VariantCounts `json:"b"`
	PA          float64       `json:"p_a"`
	PB          float64       `json:"p_b"`
	Difference  float64       `json:"difference"` // PB - PA
	StdError    float64       `json:"std_error"`  // pooled SE
	ZScore      float64       `json:"z_score"`
	PValue      float64       `json:"p_value"`      // two-tailed
	LiftPercent float64       `json:"lift_percent"` // (PB - PA) / PA * 100
}

// BetaParams is a Beta(alpha, beta) distribution.
type BetaParams struct {
	Alpha float64 `json:"alpha"`
	Beta  float64 `json:"beta"`
}

// BayesianTest is the result of a Beta-Binomial conjugate analysis
// comparing A (control) vs B (challenger). PosteriorA and PosteriorB
// are the updated posteriors after observing each variant's data.
//
// CredibleInterval95 is the 95% interval on the difference (PB - PA).
//
// Precision: Monte Carlo with 10,000 samples gives ~4 decimal places
// of confidence on ProbBBetter. Production uses a fresh random source
// per call; tests pin the seed for determinism.
type BayesianTest struct {
	A                  VariantCounts `json:"a"`
	B                  VariantCounts `json:"b"`
	PosteriorA         BetaParams    `json:"posterior_a"`
	PosteriorB         BetaParams    `json:"posterior_b"`
	ProbBBetter        float64       `json:"prob_b_better"`
	ExpectedLift       float64       `json:"expected_lift"`
	CredibleInterval95 [2]float64    `json:"credible_interval_95"`
}

// monteCarloSamples is the per-call sample budget for the Bayesian
// analysis. Documented at type level — kept as a named constant so
// tests can exercise the same value the production code uses.
const monteCarloSamples = 10_000

// phi is the standard normal CDF expressed via math.Erf:
//
//	Phi(z) = 0.5 * (1 + Erf(z / sqrt(2)))
//
// Used for two-tailed p-values: p = 2 * (1 - Phi(|z|)).
func phi(z float64) float64 {
	return 0.5 * (1 + math.Erf(z/math.Sqrt2))
}

// TwoProportionTest runs a pooled two-proportion z-test comparing A
// against B for the operator-facing reader. The math:
//
//	pA   = a.Hits / a.Sent
//	pB   = b.Hits / b.Sent
//	pHat = (a.Hits + b.Hits) / (a.Sent + b.Sent)
//	SE   = sqrt( pHat * (1 - pHat) * (1/nA + 1/nB) )
//	z    = (pB - pA) / SE
//	p    = 2 * (1 - Phi(|z|))
//
// Naming note: the existing winner.go already has a `TwoProportionZ`
// helper that returns just the z-score for the legacy picker. To
// avoid a name collision (Go forbids overloads), this struct-returning
// reader-side entry point is `TwoProportionTest`. Callers that want
// just the z can still use the legacy helper.
func TwoProportionTest(a, b VariantCounts) ProportionTest {
	out := ProportionTest{A: a, B: b}
	if a.Sent <= 0 || b.Sent <= 0 {
		// No data on one side — the test can't run. PValue must be the
		// "not significant" value (1), NOT the Go zero (0); a 0 here would
		// make a caller's `PValue < alpha` test spuriously fire on no data.
		out.PValue = 1
		return out
	}
	out.PA = float64(a.Hits) / float64(a.Sent)
	out.PB = float64(b.Hits) / float64(b.Sent)
	out.Difference = out.PB - out.PA
	pHat := float64(a.Hits+b.Hits) / float64(a.Sent+b.Sent)
	se := math.Sqrt(pHat * (1 - pHat) * (1.0/float64(a.Sent) + 1.0/float64(b.Sent)))
	out.StdError = se
	if se == 0 {
		// Both proportions identical or degenerate — z is 0, p is 1.
		out.PValue = 1
		return out
	}
	out.ZScore = out.Difference / se
	// Two-tailed p-value via the symmetric tail of the standard normal.
	out.PValue = 2 * (1 - phi(math.Abs(out.ZScore)))
	if out.PA > 0 {
		out.LiftPercent = (out.PB - out.PA) / out.PA * 100
	}
	return out
}

// betaSampler draws Beta(alpha, beta) samples from rng. It uses the
// gamma-ratio identity X = G1 / (G1 + G2) where G1 ~ Gamma(alpha, 1)
// and G2 ~ Gamma(beta, 1). The Marsaglia & Tsang gamma sampler is
// numerically stable for shape >= 1; we boost shape < 1 via the
// "shape + 1" trick (multiply by U^(1/shape)).
func betaSample(rng *rand.Rand, alpha, beta float64) float64 {
	g1 := gammaSample(rng, alpha)
	g2 := gammaSample(rng, beta)
	if g1+g2 == 0 {
		return 0
	}
	return g1 / (g1 + g2)
}

// gammaSample draws from Gamma(shape, 1) via Marsaglia & Tsang.
// We cap shape at >= 1 inside the loop; shape in (0, 1) is handled
// by the "shape + 1" boost trick.
func gammaSample(rng *rand.Rand, shape float64) float64 {
	if shape < 1 {
		// Boost: G(shape) = G(shape+1) * U^(1/shape)
		u := rng.Float64()
		if u <= 0 {
			u = 1e-300
		}
		return gammaSample(rng, shape+1) * math.Pow(u, 1.0/shape)
	}
	d := shape - 1.0/3.0
	c := 1.0 / math.Sqrt(9.0*d)
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
			return d * v
		}
		if math.Log(u) < 0.5*x*x+d*(1-v+math.Log(v)) {
			return d * v
		}
	}
}

// BayesianPosterior runs the Beta-Binomial Monte Carlo comparison.
// Prior: Beta(1, 1) — uniform on [0, 1], a standard "I know nothing"
// choice that lets the data dominate the posterior. Posterior for a
// variant with (Sent, Hits) is Beta(1+Hits, 1+Sent-Hits).
//
// rng (when non-nil) seeds the sampler; production callers pass nil
// and get a fresh source each call. Tests inject a deterministic
// rng so the assertions stay stable.
func BayesianPosterior(a, b VariantCounts) BayesianTest {
	return bayesianPosteriorWithRNG(a, b, nil)
}

// bayesianPosteriorWithRNG is the test-injectable form. Exported only
// to the package; tests in stats_test.go call this with a seeded
// *rand.Rand to make the Monte Carlo deterministic.
func bayesianPosteriorWithRNG(a, b VariantCounts, rng *rand.Rand) BayesianTest {
	out := BayesianTest{A: a, B: b}
	out.PosteriorA = BetaParams{
		Alpha: 1 + float64(a.Hits),
		Beta:  1 + float64(a.Sent-a.Hits),
	}
	out.PosteriorB = BetaParams{
		Alpha: 1 + float64(b.Hits),
		Beta:  1 + float64(b.Sent-b.Hits),
	}
	if rng == nil {
		// Production: fresh random source per call. We accept the
		// per-call allocation; the alternative (a package-global
		// singleton) creates a hidden contention point and would be
		// harder to reason about across goroutines.
		rng = rand.New(rand.NewSource(rand.Int63()))
	}

	betterCount := 0
	diffs := make([]float64, monteCarloSamples)
	liftSum := 0.0
	liftN := 0
	for i := 0; i < monteCarloSamples; i++ {
		sa := betaSample(rng, out.PosteriorA.Alpha, out.PosteriorA.Beta)
		sb := betaSample(rng, out.PosteriorB.Alpha, out.PosteriorB.Beta)
		if sb > sa {
			betterCount++
		}
		diffs[i] = sb - sa
		if sa > 0 {
			liftSum += (sb - sa) / sa
			liftN++
		}
	}
	out.ProbBBetter = float64(betterCount) / float64(monteCarloSamples)
	if liftN > 0 {
		out.ExpectedLift = liftSum / float64(liftN)
	}
	// 95% credible interval on the difference: the 2.5th and 97.5th
	// percentiles of the diffs sample.
	sort.Float64s(diffs)
	loIdx := int(0.025 * float64(monteCarloSamples))
	hiIdx := int(0.975 * float64(monteCarloSamples))
	if hiIdx >= monteCarloSamples {
		hiIdx = monteCarloSamples - 1
	}
	out.CredibleInterval95 = [2]float64{diffs[loIdx], diffs[hiIdx]}
	return out
}

// BonferroniAlpha returns the per-comparison alpha threshold under
// Bonferroni correction for `numComparisons` simultaneous tests with
// family-wise alpha = familyAlpha. Returns familyAlpha when
// numComparisons <= 1 (no correction needed).
//
// We surface the raw p-value AND a `significant_at_95` flag computed
// against the corrected alpha so the operator can read both: the
// uncorrected p-value (for context) and the conservative decision
// (for action).
func BonferroniAlpha(familyAlpha float64, numComparisons int) float64 {
	if numComparisons <= 1 {
		return familyAlpha
	}
	return familyAlpha / float64(numComparisons)
}
