// SPDX-License-Identifier: AGPL-3.0-only
package predictive_clv

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"testing"
	"time"
)

// reasonOf returns the reason of a FitBGNBD rejection, or "" when err is
// not a *FitError.
func reasonOf(err error) FitRejectReason {
	var fe *FitError
	if errors.As(err, &fe) {
		return fe.Reason
	}
	return ""
}

// requireRejection fails the test unless err is a rejection for want that
// wraps ErrFitRejected and mentions every fragment.
func requireRejection(t *testing.T, err error, want FitRejectReason, fragments ...string) {
	t.Helper()
	if !errors.Is(err, ErrFitRejected) {
		t.Fatalf("error = %v, want one wrapping ErrFitRejected", err)
	}
	if got := reasonOf(err); got != want {
		t.Fatalf("rejection reason = %q, want %q (error: %v)", got, want, err)
	}
	for _, fragment := range fragments {
		if !strings.Contains(err.Error(), fragment) {
			t.Errorf("error %q does not mention %q", err, fragment)
		}
	}
}

// bridgeFixture returns, bit for bit, the summaries internal/predictive's
// bridge builds from its makeSignals(n) test base. Customer i placed 1+i%6
// orders, first ordered 20+i%40 weeks ago, and last ordered (i%5)/5 of the
// way through that age, so every fifth customer placed all their orders at
// one instant. The pattern repeats every 120 customers, so a base of 120*k
// customers is the 120 base replicated k times, with the same
// maximum-likelihood fit.
//
// The bridge measures time through time.Duration, and so does this
// fixture. Recency computed directly in float64 differs from the bridge's
// in the last bit for 21 of every 120 customers. Near the likelihood's
// rounding floor those bits change the optimizer's path.
//
// With mergeSameInstant, same-instant orders are one purchase occasion
// (X = 0), which is what the bridge produces now. Without it they are
// X = orders-1 repeats at Tx = 0, which is what the bridge produced when its
// fit diverged in CI.
func bridgeFixture(n int, mergeSameInstant bool) []CustomerSummary {
	const week = 7 * 24 * time.Hour
	out := make([]CustomerSummary, 0, n)
	for i := 0; i < n; i++ {
		orders := 1 + i%6
		ageWeeks := float64(20 + i%40)
		recencyWeeks := ageWeeks * float64(i%5) / 5
		// How long before now the first and the last order were placed.
		sinceFirst := time.Duration(ageWeeks * float64(week))
		sinceLast := time.Duration((ageWeeks - recencyWeeks) * float64(week))
		x := float64(orders - 1)
		tx := (sinceFirst - sinceLast).Hours() / week.Hours()
		if tx == 0 && mergeSameInstant {
			x = 0
		}
		out = append(out, CustomerSummary{X: x, Tx: tx, T: sinceFirst.Hours() / week.Hours()})
	}
	return out
}

// shuffled returns summaries in the row order rand.Shuffle gives for seed.
// internal/predictive loads its signals without an ORDER BY, so the row
// order a fit sees is up to the query plan.
func shuffled(summaries []CustomerSummary, seed int64) []CustomerSummary {
	out := append([]CustomerSummary(nil), summaries...)
	rand.New(rand.NewSource(seed)).Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// withWeight returns summaries with every Weight set to w: each customer
// replicated w times.
func withWeight(summaries []CustomerSummary, w float64) []CustomerSummary {
	out := append([]CustomerSummary(nil), summaries...)
	for i := range out {
		out[i].Weight = w
	}
	return out
}

// TestFitBGNBD_RejectsTheInputThatDivergedInCI replays the fit that broke
// TestBGNBDForecastFor in internal/predictive. 33 of the 200 customers have
// X > 0 repeats at Tx = 0, so the likelihood has no maximum. Nelder-Mead
// ran alpha to 5e-324 on darwin/arm64 and 8.07e-309 on linux/amd64, with a
// log-likelihood of +55,879 or +134,112. Both fits satisfied
// Params.Valid(), the only check FitTenantBGNBD made, so it forecast from
// rounding noise.
func TestFitBGNBD_RejectsTheInputThatDivergedInCI(t *testing.T) {
	summaries := bridgeFixture(200, false)
	res, err := FitBGNBD(summaries, FitOptions{})
	requireRejection(t, err, RejectUnboundedLikelihood, "33 of 200 summaries", "index 5")
	if res != (FitResult{}) {
		t.Errorf("an input rejection must not run the optimizer, got %+v", res)
	}

	// Second line of defense: were the input check bypassed, the outcome
	// checks would reject the point the optimizer still diverges to.
	raw := optimizeBGNBD(summaries, FitOptions{})
	if !raw.Params.Valid() {
		t.Fatalf("precondition: the diverged fit satisfies Params.Valid(), which is why it went unnoticed; got %+v", raw.Params)
	}
	requireRejection(t, assessFit(raw, summaries), RejectParamsOutOfRange, "ln(alpha/tau)")

	// The same base with same-instant orders merged fits, and is accepted.
	if _, mergedErr := FitBGNBD(bridgeFixture(200, true), FitOptions{}); mergedErr != nil {
		t.Fatalf("the merged base must fit: %v", mergedErr)
	}
}

// TestCheckParamRange_RejectsTheDivergedCIParams pins the two parameter
// sets CI's diverged fits produced (see above), independent of the
// optimizer path this toolchain takes. Params.Valid() accepts both; the
// range check does not.
func TestCheckParamRange_RejectsTheDivergedCIParams(t *testing.T) {
	const tau = 39.5 // the fixture's mean T
	for name, p := range map[string]Params{
		"darwin/arm64": {R: 0.0014284791921180878, Alpha: 5e-324, A: 6.81100496402496e-234, B: 3.3300815379406123e-15},
		"linux/amd64":  {R: 0.0013656892112855605, Alpha: 8.06573234667625e-309, A: 2.559983327829747e+305, B: 9.29768508633553e+137},
	} {
		if !p.Valid() {
			t.Fatalf("%s: precondition: Params.Valid() accepts the diverged params %+v", name, p)
		}
		err := checkParamRange(p, tau)
		if reasonOf(err) != RejectParamsOutOfRange || !strings.Contains(err.Error(), "ln(alpha/tau)") {
			t.Errorf("%s: checkParamRange(%+v) = %v, want a params_out_of_range rejection of ln(alpha/tau)", name, p, err)
		}
	}
}

func TestFitBGNBD_RejectsInvalidInput(t *testing.T) {
	valid := []CustomerSummary{{X: 2, Tx: 5, T: 10}, {X: 0, Tx: 0, T: 8}}
	if err := validateSummaries(valid); err != nil {
		t.Fatalf("precondition: the valid rows must pass, got %v", err)
	}

	res, err := FitBGNBD(nil, FitOptions{})
	requireRejection(t, err, RejectInvalidInput, "at least one customer summary")
	if res != (FitResult{}) {
		t.Errorf("empty input must return a zero FitResult, got %+v", res)
	}

	for _, tc := range []struct {
		name string
		bad  CustomerSummary
		want string
	}{
		{"NaN X", CustomerSummary{X: math.NaN(), Tx: 1, T: 2}, "non-finite"},
		{"infinite T", CustomerSummary{X: 1, Tx: 1, T: math.Inf(1)}, "non-finite"},
		{"NaN Tx", CustomerSummary{X: 1, Tx: math.NaN(), T: 2}, "non-finite"},
		{"NaN weight", CustomerSummary{X: 1, Tx: 1, T: 2, Weight: math.NaN()}, "non-finite"},
		{"infinite weight", CustomerSummary{X: 1, Tx: 1, T: 2, Weight: math.Inf(1)}, "non-finite"},
		{"zero T", CustomerSummary{X: 0, Tx: 0, T: 0}, "T = 0"},
		{"negative T", CustomerSummary{X: 0, Tx: 0, T: -3}, "T = -3"},
		{"negative X", CustomerSummary{X: -1, Tx: 1, T: 2}, "X = -1"},
		{"fractional X below one", CustomerSummary{X: 0.5, Tx: 1, T: 2}, "X = 0.5"},
		{"negative Tx", CustomerSummary{X: 1, Tx: -0.5, T: 2}, "Tx = -0.5"},
		{"Tx beyond T", CustomerSummary{X: 1, Tx: 3, T: 2}, "Tx = 3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			summaries := append(append([]CustomerSummary(nil), valid...), tc.bad)
			res, err := FitBGNBD(summaries, FitOptions{})
			requireRejection(t, err, RejectInvalidInput, "summary 2 ", tc.want)
			if res != (FitResult{}) {
				t.Errorf("an input rejection must not run the optimizer, got %+v", res)
			}
		})
	}
}

// A base where nobody has purchased again has no maximum-likelihood fit:
// the likelihood only rises toward a zero purchase rate. It is common (a
// new tenant), so it must fall back rather than forecast zero for everyone.
func TestFitBGNBD_RejectsBaseWithoutRepeatPurchases(t *testing.T) {
	var singles []CustomerSummary
	for i := 0; i < 60; i++ {
		singles = append(singles, CustomerSummary{X: 0, Tx: 0, T: float64(5 + i)})
	}
	res, err := FitBGNBD(singles, FitOptions{})
	requireRejection(t, err, RejectNoRepeatTransactions, "none of the 60 summaries")
	if res != (FitResult{}) {
		t.Errorf("an input rejection must not run the optimizer, got %+v", res)
	}

	withRepeat := append(append([]CustomerSummary(nil), singles...), CustomerSummary{X: 1, Tx: 3, T: 9})
	if repeatErr := validateSummaries(withRepeat); repeatErr != nil {
		t.Errorf("one repeat purchase makes the base fittable, got %v", repeatErr)
	}
}

func TestFitBGNBD_RejectsNonConvergence(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	summaries := generateBGNBDSample(rng, Params{R: 0.6, Alpha: 3.0, A: 1.0, B: 2.0}, 40, 1000)

	res, err := FitBGNBD(summaries, FitOptions{MaxIterations: 5})
	requireRejection(t, err, RejectNotConverged, "all 5 iterations", "rounding floor")
	if res.Converged || res.Iterations != 5 {
		t.Errorf("rejected fit reports Converged=%v Iterations=%d, want false and 5", res.Converged, res.Iterations)
	}
	// Five iterations in, the simplex spans about 90 in log-likelihood, ten
	// orders of magnitude above what rounding can explain.
	if floor := roundingFloorFactor * logLikelihoodRoundingScale(res.Params, summaries); !(res.Spread > 1e6*floor) {
		t.Errorf("after 5 iterations the simplex spans %.3g, want over 10^6 times the rounding floor %.3g", res.Spread, floor)
	}
	// The rejected fit is still reported, honestly, for logging.
	if !res.Params.Valid() || res.LogLikelihood != LogLikelihood(res.Params, summaries) {
		t.Errorf("rejected fit must describe the best point reached: %+v", res)
	}

	res, err = FitBGNBD(summaries, FitOptions{})
	if err != nil || !res.Converged || res.Iterations >= 2000 {
		t.Fatalf("the default budget must converge on this sample: err=%v %+v", err, res)
	}
}

// Converged is judged on the final simplex, so a run whose last allowed
// iteration meets the tolerance has converged even though it used every
// iteration. Spread is that final simplex's spread.
func TestNelderMead_ReportsConvergenceOnTheFinalSimplex(t *testing.T) {
	sphere := func(x []float64) float64 { return x[0]*x[0] + x[1]*x[1] + x[2]*x[2] }
	x0 := []float64{3, -2, 5}
	free := nelderMead(sphere, x0, NelderMeadOptions{MaxIterations: 5000, Tolerance: 1e-14})
	if !free.Converged || free.Iterations < 2 || free.Iterations >= 5000 {
		t.Fatalf("unconstrained run must converge within the budget: %+v", free)
	}
	if !(free.Spread >= 0 && free.Spread < 1e-14) {
		t.Errorf("a converged run's spread = %v, want in [0, 1e-14)", free.Spread)
	}
	x, f, iters := NelderMead(sphere, x0, NelderMeadOptions{MaxIterations: 5000, Tolerance: 1e-14})
	if f != free.F || iters != free.Iterations || x[0] != free.X[0] || x[1] != free.X[1] || x[2] != free.X[2] {
		t.Fatalf("NelderMead = (%v, %v, %d), want nelderMead's (%v, %v, %d)", x, f, iters, free.X, free.F, free.Iterations)
	}

	k := free.Iterations
	exact := nelderMead(sphere, x0, NelderMeadOptions{MaxIterations: k, Tolerance: 1e-14})
	if !exact.Converged || exact.Iterations != k || exact.F != free.F || exact.Spread != free.Spread {
		t.Errorf("a budget of exactly %d iterations must converge at the same point: %+v", k, exact)
	}
	short := nelderMead(sphere, x0, NelderMeadOptions{MaxIterations: k - 1, Tolerance: 1e-14})
	if short.Converged || short.Iterations != k-1 || !(short.Spread >= 1e-14) {
		t.Errorf("a budget of %d iterations must not converge, and its spread must be at least the tolerance: %+v", k-1, short)
	}
	if empty := nelderMead(sphere, nil, NelderMeadOptions{}); empty.Converged || !math.IsNaN(empty.Spread) {
		t.Errorf("a zero-dimensional problem has no simplex to converge: %+v", empty)
	}
}

// A search that never reaches a point where the likelihood is finite
// reports the optimizer's finite penalty as its log-likelihood. With r at
// 1e308 every simplex vertex overflows lnGamma, the simplex is flat at the
// penalty, and Nelder-Mead stops at once.
func TestFitBGNBD_RejectsSearchThatNeverReachesAFiniteLikelihood(t *testing.T) {
	seed := Params{R: 1e308, Alpha: 1, A: 1, B: 1}
	res, err := FitBGNBD(bridgeFixture(200, true), FitOptions{Seed: &seed})
	requireRejection(t, err, RejectNonFiniteLikelihood)
	if !isFinite(res.LogLikelihood) {
		t.Errorf("precondition: the optimizer reports a finite penalty as the log-likelihood, got %v", res.LogLikelihood)
	}
}

func TestCheckFinite(t *testing.T) {
	summaries := bridgeFixture(200, true)
	good := Params{R: 0.5, Alpha: 4, A: 0.8, B: 2.5}
	if err := checkFinite(FitResult{Params: good, LogLikelihood: LogLikelihood(good, summaries)}, summaries); err != nil {
		t.Fatalf("finite fit rejected: %v", err)
	}
	for _, tc := range []struct {
		name string
		res  FitResult
		want string
	}{
		{"alpha underflowed to zero", FitResult{Params: Params{R: 0.5, Alpha: 0, A: 0.8, B: 2.5}, LogLikelihood: -1}, "left the model's domain"},
		{"r overflowed", FitResult{Params: Params{R: math.Inf(1), Alpha: 4, A: 0.8, B: 2.5}, LogLikelihood: -1}, "left the model's domain"},
		{"NaN log-likelihood", FitResult{Params: good, LogLikelihood: math.NaN()}, "fitted log-likelihood is NaN"},
		{"infinite log-likelihood", FitResult{Params: good, LogLikelihood: math.Inf(1)}, "fitted log-likelihood is +Inf"},
		{"likelihood not finite at the params", FitResult{Params: Params{R: 1e308, Alpha: 1, A: 1, B: 1}, LogLikelihood: -1e12}, "at the fitted params"},
	} {
		requireRejection(t, checkFinite(tc.res, summaries), RejectNonFiniteLikelihood, tc.want)
	}
}

func TestCheckParamRange(t *testing.T) {
	const tau = 40.0
	inside := math.Exp(36)    // 36 < 52*ln 2 ≈ 36.04
	outside := math.Exp(36.1) // 36.1 > 36.04
	base := Params{R: 0.5, Alpha: 4, A: 0.8, B: 2.5}
	if err := checkParamRange(base, tau); err != nil {
		t.Fatalf("an ordinary fit is out of range: %v", err)
	}
	set := []struct {
		name string
		with func(p Params, v float64) Params
	}{
		{"ln r", func(p Params, v float64) Params { p.R = v; return p }},
		{"ln(alpha/tau)", func(p Params, v float64) Params { p.Alpha = v * tau; return p }},
		{"ln a", func(p Params, v float64) Params { p.A = v; return p }},
		{"ln b", func(p Params, v float64) Params { p.B = v; return p }},
	}
	for _, param := range set {
		for _, v := range []float64{inside, 1 / inside} {
			if err := checkParamRange(param.with(base, v), tau); err != nil {
				t.Errorf("%s = %.2f is inside the range but rejected: %v", param.name, math.Log(v), err)
			}
		}
		for _, v := range []float64{outside, 1 / outside, math.NaN()} {
			err := checkParamRange(param.with(base, v), tau)
			requireRejection(t, err, RejectParamsOutOfRange, param.name+" = ")
		}
	}

	// alpha is measured against tau, so the verdict does not depend on the
	// time unit: the same fit in weeks, days, seconds, or units so coarse or
	// fine that ln(alpha) alone would be far outside the bound.
	for _, unit := range []float64{1e20, 7, 1, 1.0 / 604800, 1e-20} {
		accepted := Params{R: 0.5, Alpha: 4 / unit, A: 0.8, B: 2.5}
		if err := checkParamRange(accepted, tau/unit); err != nil {
			t.Errorf("unit %g: in-range fit rejected: %v", unit, err)
		}
		rejected := Params{R: 0.5, Alpha: tau / outside / unit, A: 0.8, B: 2.5}
		requireRejection(t, checkParamRange(rejected, tau/unit), RejectParamsOutOfRange, "ln(alpha/tau)")
	}
}

// assessFit measures alpha against the weighted mean observation length,
// with a non-positive Weight counting once as everywhere else.
func TestAssessFit_MeasuresAlphaAgainstTheMeanObservationLength(t *testing.T) {
	summaries := []CustomerSummary{{X: 2, Tx: 5, T: 10, Weight: 3}, {X: 0, Tx: 0, T: 40}}
	const tau = 17.5 // (3*10 + 1*40) / 4
	if got := meanObservationLength(summaries); got != tau {
		t.Fatalf("meanObservationLength = %v, want %v", got, tau)
	}
	fit := func(lnAlphaOverTau float64) FitResult {
		p := Params{R: 0.5, Alpha: tau * math.Exp(lnAlphaOverTau), A: 0.8, B: 2.5}
		return FitResult{Params: p, LogLikelihood: LogLikelihood(p, summaries), Converged: true}
	}
	// ln(alpha) is about 37.9 here, beyond the bound, but alpha/tau is not.
	if err := assessFit(fit(35), summaries); err != nil {
		t.Errorf("alpha = e^35 tau is in range: %v", err)
	}
	requireRejection(t, assessFit(fit(36.1), summaries), RejectParamsOutOfRange, "ln(alpha/tau) = 36.1")
}

// The bound must hold for every parameter value, and it must be tight
// enough to mean something: a single customer's likelihood approaches it.
func TestLogLikelihoodUpperBound_HoldsAndIsTight(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	summaries := generateBGNBDSample(rng, Params{R: 0.8, Alpha: 2.0, A: 0.5, B: 3.0}, 52, 500)
	bound, _ := logLikelihoodUpperBound(summaries)
	for i := 0; i < 300; i++ {
		p := Params{
			R:     math.Exp(rng.Float64()*16 - 8),
			Alpha: math.Exp(rng.Float64()*16 - 8),
			A:     math.Exp(rng.Float64()*16 - 8),
			B:     math.Exp(rng.Float64()*16 - 8),
		}
		if ll := LogLikelihood(p, summaries); ll > bound {
			t.Fatalf("LogLikelihood(%+v) = %v exceeds the upper bound %v", p, ll, bound)
		}
	}

	// One customer, x = 1 at t_x = T = 1: the individual likelihood is
	// lambda*e^(-lambda), at most 1/e, so the bound is -1. A Gamma(r, r)
	// rate concentrated at lambda = 1 approaches it.
	one := []CustomerSummary{{X: 1, Tx: 1, T: 1}}
	oneBound, _ := logLikelihoodUpperBound(one)
	if oneBound != -1 {
		t.Fatalf("bound for x=1, t_x=T=1 = %v, want -1", oneBound)
	}
	ll := LogLikelihood(Params{R: 1e6, Alpha: 1e6, A: 1, B: 1}, one)
	if ll > oneBound || ll < oneBound-1e-5 {
		t.Errorf("LogLikelihood at the concentrated rate = %.12g, want within 1e-5 below %v", ll, oneBound)
	}
	if err := checkLikelihoodBound(ll, one); err != nil {
		t.Errorf("a likelihood at its bound is legitimate: %v", err)
	}
	// A Weight replicates the row, in the bound as in the likelihood.
	four := []CustomerSummary{{X: 1, Tx: 1, T: 1, Weight: 4}}
	if fourBound, _ := logLikelihoodUpperBound(four); fourBound != 4*oneBound {
		t.Errorf("bound for a row of weight 4 = %v, want %v", fourBound, 4*oneBound)
	}

	// A customer with no repeats is bounded by 0 (probability 1 of no
	// further purchases), which the likelihood never reaches.
	zero := []CustomerSummary{{X: 0, Tx: 0, T: 10}}
	if zb, _ := logLikelihoodUpperBound(zero); zb != 0 {
		t.Errorf("bound for x=0 = %v, want 0", zb)
	}
}

func TestCheckLikelihoodBound(t *testing.T) {
	summaries := bridgeFixture(200, true)
	bound, scale := logLikelihoodUpperBound(summaries)
	if err := checkLikelihoodBound(bound, summaries); err != nil {
		t.Errorf("a log-likelihood equal to the bound is possible: %v", err)
	}
	// Rounding-sized excess is tolerated; a real excess is not.
	if err := checkLikelihoodBound(bound+1e-9*scale, summaries); err != nil {
		t.Errorf("a rounding-sized excess must be tolerated: %v", err)
	}
	requireRejection(t, checkLikelihoodBound(bound+1, summaries), RejectImpossibleLikelihood, "exceeds")
	requireRejection(t, checkLikelihoodBound(55878.8, summaries), RejectImpossibleLikelihood, "55878.8")
}

// assessFit reports the first failing check, most fundamental first.
func TestAssessFit_ReportsTheFirstFailingCheck(t *testing.T) {
	summaries := bridgeFixture(200, true)
	bound, _ := logLikelihoodUpperBound(summaries)
	inRange := Params{R: 0.5, Alpha: 4, A: 0.8, B: 2.5}
	outOfRange := Params{R: 0.5, Alpha: 1e-300, A: 0.8, B: 2.5}
	llIn := LogLikelihood(inRange, summaries)
	llOut := LogLikelihood(outOfRange, summaries)
	// A spread of 1 is far above the rounding floor at these params, which
	// is near 1e-10 (TestCheckConverged_ComparesTheSpreadWithTheFloor).
	for _, tc := range []struct {
		name string
		res  FitResult
		want FitRejectReason
	}{
		{"out of range, above bound, not converged", FitResult{Params: outOfRange, LogLikelihood: llOut + 1e6, Spread: 1}, RejectParamsOutOfRange},
		{"above bound, not converged", FitResult{Params: inRange, LogLikelihood: bound + 1, Spread: 1}, RejectImpossibleLikelihood},
		{"not converged", FitResult{Params: inRange, LogLikelihood: llIn, Spread: 1}, RejectNotConverged},
		{"NaN likelihood, out of range", FitResult{Params: outOfRange, LogLikelihood: math.NaN(), Converged: true}, RejectNonFiniteLikelihood},
	} {
		if got := reasonOf(assessFit(tc.res, summaries)); got != tc.want {
			t.Errorf("%s: reason = %q, want %q", tc.name, got, tc.want)
		}
	}
	for name, res := range map[string]FitResult{
		"converged":                         {Params: inRange, LogLikelihood: llIn, Converged: true, Spread: 1e-10},
		"settled within the rounding floor": {Params: inRange, LogLikelihood: llIn, Spread: 0},
	} {
		if err := assessFit(res, summaries); err != nil {
			t.Errorf("%s: a fit passing every check was rejected: %v", name, err)
		}
	}
}

// checkConverged accepts a search that did not converge only when its
// spread is within the rounding floor at its best point, inclusive, and it
// fails closed on a NaN spread.
func TestCheckConverged_ComparesTheSpreadWithTheFloor(t *testing.T) {
	summaries := bridgeFixture(200, true)
	p := Params{R: 0.5, Alpha: 4, A: 0.8, B: 2.5}
	floor := roundingFloorFactor * logLikelihoodRoundingScale(p, summaries)
	if !(floor > 1e-12 && floor < 1e-9) {
		t.Fatalf("precondition: the floor at these well-conditioned params should lie between 1e-12 and 1e-9, got %.3g", floor)
	}
	if err := checkConverged(FitResult{Params: p, Iterations: 2000, Spread: floor}, summaries); err != nil {
		t.Errorf("a spread equal to the floor is rounding: %v", err)
	}
	above := math.Nextafter(floor, math.Inf(1))
	requireRejection(t, checkConverged(FitResult{Params: p, Iterations: 2000, Spread: above}, summaries),
		RejectNotConverged, "all 2000 iterations", "rounding floor")
	requireRejection(t, checkConverged(FitResult{Params: p, Iterations: 2000, Spread: math.NaN()}, summaries),
		RejectNotConverged)
	if err := checkConverged(FitResult{Params: p, Iterations: 7, Converged: true, Spread: 1}, summaries); err != nil {
		t.Errorf("a search that met Nelder-Mead's own tolerance is converged: %v", err)
	}
}

// The BG/NBD likelihood is a density in continuous time, so its log is
// not bounded by 0: frequent buyers measured in a coarse unit have a
// positive log-likelihood. The same fit in a unit 100 times finer is
// negative, shifted by exactly sum(x)*ln(100). A guard that rejected every
// positive log-likelihood would reject the coarse fit for its time unit
// alone.
func TestFitBGNBD_PositiveLogLikelihoodIsLegitimate(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	coarse := generateBGNBDSample(rng, Params{R: 3, Alpha: 0.1, A: 1, B: 30}, 1, 1500)
	const scale = 100.0
	fine := make([]CustomerSummary, len(coarse))
	var sumX float64
	for i, s := range coarse {
		fine[i] = CustomerSummary{X: s.X, Tx: s.Tx * scale, T: s.T * scale}
		sumX += s.X
	}

	fc, err := FitBGNBD(coarse, FitOptions{})
	if err != nil {
		t.Fatalf("coarse-unit fit rejected: %v", err)
	}
	ff, err := FitBGNBD(fine, FitOptions{})
	if err != nil {
		t.Fatalf("fine-unit fit rejected: %v", err)
	}
	if !(fc.LogLikelihood > 0) || !(ff.LogLikelihood < 0) {
		t.Fatalf("log-likelihoods = %v (coarse), %v (fine), want positive and negative", fc.LogLikelihood, ff.LogLikelihood)
	}
	if shift, want := fc.LogLikelihood-ff.LogLikelihood, sumX*math.Log(scale); math.Abs(shift-want) > 1e-3 {
		t.Errorf("unit change shifted the log-likelihood by %v, want sum(x)*ln(%v) = %v", shift, scale, want)
	}
	for _, pair := range [][2]float64{
		{fc.Params.R, ff.Params.R},
		{fc.Params.Alpha * scale, ff.Params.Alpha},
		{fc.Params.A, ff.Params.A},
		{fc.Params.B, ff.Params.B},
	} {
		if rel := math.Abs(pair[1]/pair[0] - 1); rel > 1e-4 {
			t.Errorf("the unit change moved the fit: %+v vs %+v", fc.Params, ff.Params)
			break
		}
	}
}

// referenceFit is the documented FitBGNBD procedure, written from the
// public API: Nelder-Mead from MethodOfMomentsSeed in log space, with an
// initial step of 0.25 and a penalty where the likelihood is undefined.
func referenceFit(summaries []CustomerSummary, maxIterations int) (Params, float64, int) {
	seed := MethodOfMomentsSeed(summaries)
	x0 := []float64{math.Log(seed.R), math.Log(seed.Alpha), math.Log(seed.A), math.Log(seed.B)}
	negLogLik := func(theta []float64) float64 {
		p := Params{R: math.Exp(theta[0]), Alpha: math.Exp(theta[1]), A: math.Exp(theta[2]), B: math.Exp(theta[3])}
		if !p.Valid() {
			return 1e12
		}
		ll := LogLikelihood(p, summaries)
		if math.IsNaN(ll) || math.IsInf(ll, 0) {
			return 1e12
		}
		return -ll
	}
	theta, f, iters := NelderMead(negLogLik, x0, NelderMeadOptions{MaxIterations: maxIterations, InitialStep: 0.25})
	return Params{R: math.Exp(theta[0]), Alpha: math.Exp(theta[1]), A: math.Exp(theta[2]), B: math.Exp(theta[3])}, -f, iters
}

// The guard only accepts or rejects: a fit it accepts is exactly the point
// the documented procedure finds, bit for bit. The fixtures include the
// merged base, where dropout is nearly homogeneous and a and b drift toward
// their point-mass limit (to about e^16). That is a legitimate fit the
// range check must leave alone. Replicated 100 times through Weight, the
// same base stops short of Nelder-Mead's tolerance, settled at its rounding
// floor, and is still returned exactly as found.
func TestFitBGNBD_AcceptedFitIsExactlyTheOptimizersPoint(t *testing.T) {
	rng42 := rand.New(rand.NewSource(42))
	rng7 := rand.New(rand.NewSource(7))
	for _, tc := range []struct {
		name          string
		summaries     []CustomerSummary
		maxIterations int
		converged     bool
	}{
		{"synthetic, seed 42", generateBGNBDSample(rng42, Params{R: 0.8, Alpha: 2.0, A: 0.5, B: 3.0}, 52, 4000), 4000, true},
		{"synthetic, seed 7", generateBGNBDSample(rng7, Params{R: 0.6, Alpha: 3.0, A: 1.0, B: 2.0}, 40, 1000), 0, true},
		{"same-instant orders merged", bridgeFixture(200, true), 0, true},
		{"same-instant orders merged, Weight 100", withWeight(bridgeFixture(120, true), 100), 0, false},
	} {
		res, err := FitBGNBD(tc.summaries, FitOptions{MaxIterations: tc.maxIterations})
		if err != nil {
			t.Fatalf("%s: fit rejected: %v", tc.name, err)
		}
		params, ll, iters := referenceFit(tc.summaries, tc.maxIterations)
		if res.Params != params || res.LogLikelihood != ll || res.Iterations != iters {
			t.Errorf("%s: FitBGNBD = %+v, want the optimizer's point %+v (log-likelihood %v, %d iterations)",
				tc.name, res, params, ll, iters)
		}
		if res.Converged != tc.converged {
			t.Errorf("%s: Converged = %v, want %v (spread %.3g)", tc.name, res.Converged, tc.converged, res.Spread)
		}
	}

	merged, err := FitBGNBD(bridgeFixture(200, true), FitOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if math.Log(merged.Params.A) < 10 || math.Log(merged.Params.B) < 10 {
		t.Errorf("precondition: the merged base's fit should sit near the homogeneous-dropout limit, got %+v", merged.Params)
	}
}

// ridgeForecast is the 52-week forecast for a frequent, recent buyer: 5
// repeat purchases in a year, the last 2 weeks ago.
func ridgeForecast(p Params) float64 { return ConditionalExpectedTransactions(p, 52, 5, 50, 52) }

// requireSameFit fails the test unless got is the maximum-likelihood fit
// want is, as far as a forecast can tell: the same r and alpha, the same
// mean dropout probability, and the same forecast. On the dropout ridge a
// and b are not identified separately, only their ratio is.
func requireSameFit(t *testing.T, got, want Params) {
	t.Helper()
	for _, c := range []struct {
		name      string
		got, want float64
		tolerance float64
	}{
		{"r", got.R, want.R, 1e-2},
		{"alpha", got.Alpha, want.Alpha, 1e-2},
		{"a/(a+b)", got.A / (got.A + got.B), want.A / (want.A + want.B), 1e-3},
		{"52-week forecast", ridgeForecast(got), ridgeForecast(want), 1e-3},
	} {
		if rel := math.Abs(c.got/c.want - 1); !(rel <= c.tolerance) {
			t.Errorf("%s = %.6g, want %.6g within a relative %g (fit %+v, reference %+v)",
				c.name, c.got, c.want, c.tolerance, got, want)
		}
	}
}

// TestFitBGNBD_AcceptsASearchSettledAtTheRoundingFloor pins the fits that
// the not_converged check rejected while it used Nelder-Mead's absolute
// tolerance as its test. In the bridge's base, dropout is nearly the same
// for every customer, so the maximum-likelihood fit lies on the ridge where
// a and b grow at a fixed ratio. There the log-likelihood carries rounding
// error 10^4 to 10^6 times the tolerance, and whether the simplex meets the
// tolerance before its budget runs out is chance. With the tolerance as the
// test, darwin/arm64 rejected 240 and 600 customers, row order 6 of the 200,
// row orders 1 and 3 of the 120 base at Weight 2, and Weights 2, 5 and 8.
// linux/amd64 rejected 600 customers, row orders 1 and 3 at Weight 2, and
// Weight 8. Each rejection made the bridge fall back to its heuristic for
// the whole tenant, although each rejected fit is the same fit as the
// accepted ones. Both architectures also rejected the Weight-20 base of
// TestFitBGNBD_RejectsASearchStoppedWhileClimbing and the Weight-100 base of
// TestFitBGNBD_AcceptedFitIsExactlyTheOptimizersPoint.
//
// Weights 2, 5 and 10 encode the bridge's 240, 600 and 1200 customers as
// 120 rows. Each case that stops short of the tolerance runs the whole
// 2000-iteration budget, and under CI's -race -covermode=atomic every
// likelihood evaluation costs microseconds per row, so the cases are few
// and their rows short.
func TestFitBGNBD_AcceptsASearchSettledAtTheRoundingFloor(t *testing.T) {
	fit := func(t *testing.T, summaries []CustomerSummary) FitResult {
		t.Helper()
		res, err := FitBGNBD(summaries, FitOptions{})
		if err != nil {
			t.Fatalf("fit on the dropout ridge rejected: %v", err)
		}
		return res
	}
	// Each base below is the 120 or the 200 base at another size, in another
	// row order, or with another Weight encoding, so it has the same
	// maximum-likelihood fit as its reference.
	ref120 := fit(t, bridgeFixture(120, true))
	ref200 := fit(t, bridgeFixture(200, true))

	// The subtests run one at a time. In parallel, CI's -covermode=atomic
	// makes every likelihood evaluation contend for the same coverage
	// counters, and the test ran about twice as long as it does in sequence.
	stoppedShort := 0
	check := func(name string, summaries []CustomerSummary, ref FitResult) {
		t.Run(name, func(t *testing.T) {
			res := fit(t, summaries)
			if !res.Converged {
				stoppedShort++
			}
			requireSameFit(t, res.Params, ref.Params)
		})
	}
	for _, n := range []int{240, 600} {
		check(fmt.Sprintf("%d customers", n), bridgeFixture(n, true), ref120)
	}
	for seed := int64(1); seed <= 6; seed++ {
		check(fmt.Sprintf("200 customers, row order %d", seed), shuffled(bridgeFixture(200, true), seed), ref200)
	}
	for seed := int64(1); seed <= 3; seed++ {
		check(fmt.Sprintf("120 customers at Weight 2, row order %d", seed),
			shuffled(withWeight(bridgeFixture(120, true), 2), seed), ref120)
	}
	for _, w := range []float64{2, 5, 8, 10} {
		check(fmt.Sprintf("120 customers, Weight %g", w), withWeight(bridgeFixture(120, true), w), ref120)
	}
	if stoppedShort == 0 {
		t.Fatal("precondition: every fit met Nelder-Mead's tolerance, so none exercised the rounding floor")
	}
}

// A search stopped while still climbing is rejected on the same ridge. The
// bridge's base at Weight 20 (2400 customers) reaches its rounding floor
// after about 200 iterations. Stopped at 150, its simplex still spans
// millions of times the floor. Stopped at 300, it spans a small fraction of
// the floor and is accepted, and the rest of the default budget finds
// nothing better than rounding can tell apart.
func TestFitBGNBD_RejectsASearchStoppedWhileClimbing(t *testing.T) {
	summaries := withWeight(bridgeFixture(120, true), 20)
	floorAt := func(res FitResult) float64 {
		return roundingFloorFactor * logLikelihoodRoundingScale(res.Params, summaries)
	}

	climbing, err := FitBGNBD(summaries, FitOptions{MaxIterations: 150})
	requireRejection(t, err, RejectNotConverged, "all 150 iterations", "rounding floor")
	if floor := floorAt(climbing); !(climbing.Spread > 1e4*floor) {
		t.Errorf("stopped at 150 iterations, the simplex spans %.3g, want over 10^4 times the floor %.3g", climbing.Spread, floor)
	}

	settled, err := FitBGNBD(summaries, FitOptions{MaxIterations: 300})
	if err != nil {
		t.Fatalf("stopped at 300 iterations, the search has settled and must be accepted: %v", err)
	}
	if settled.Converged {
		t.Fatalf("precondition: the search must stop short of the tolerance at 300 iterations: %+v", settled)
	}
	if floor := floorAt(settled); !(settled.Spread <= floor/4) {
		t.Errorf("stopped at 300 iterations, the simplex spans %.3g, want at most a quarter of the floor %.3g", settled.Spread, floor)
	}

	full, err := FitBGNBD(summaries, FitOptions{})
	if err != nil {
		t.Fatalf("the default budget's fit must be accepted: %v", err)
	}
	requireSameFit(t, settled.Params, full.Params)
	// The best point only ever improves, so the gain is not negative.
	if gain, floor := full.LogLikelihood-settled.LogLikelihood, floorAt(full); !(gain >= 0 && gain <= floor) {
		t.Errorf("the iterations after settling gained %.3g in log-likelihood, want between 0 and the floor %.3g", gain, floor)
	}
}

// TestLogLikelihoodRoundingScale_TracksTheMeasuredRounding calibrates the
// rounding floor against the rounding LogLikelihood shows. At a fitted
// point, moving every parameter by up to 1e-13 of its value changes the
// log-likelihood by rounding alone: the exact likelihood is flat to far
// better than that there. The range of the values seen must stay within
// half the floor, so that a settled simplex, whose spread is such rounding,
// clears the floor with room.
//
// On the dropout ridge the scale comes mostly from terms that cancel, and
// the measured rounding must also reach a sixteenth of the scale. If
// LogLikelihoodSingle were rewritten to avoid that cancellation, its
// rounding would fall by orders of magnitude and the scale would overstate
// it, so the floor would accept searches that are still climbing. This test
// would then fail. The measured rounding on the ridge is also over 1000
// times Nelder-Mead's default tolerance, which is why that tolerance cannot
// judge such a fit.
//
// The 1200-customer and Weight-100 bases replicate the 120 base, so the 120
// base's fit is their fitted point too.
func TestLogLikelihoodRoundingScale_TracksTheMeasuredRounding(t *testing.T) {
	measuredRounding := func(p Params, summaries []CustomerSummary) float64 {
		rng := rand.New(rand.NewSource(1))
		lo, hi := math.Inf(1), math.Inf(-1)
		for i := 0; i < 64; i++ {
			q := p
			for _, v := range []*float64{&q.R, &q.Alpha, &q.A, &q.B} {
				*v *= 1 + (2*rng.Float64()-1)*1e-13
			}
			ll := LogLikelihood(q, summaries)
			lo, hi = math.Min(lo, ll), math.Max(hi, ll)
		}
		return hi - lo
	}
	fitted := func(summaries []CustomerSummary) Params {
		t.Helper()
		res, err := FitBGNBD(summaries, FitOptions{})
		if err != nil {
			t.Fatalf("fit rejected: %v", err)
		}
		return res.Params
	}
	const defaultTolerance = 1e-9
	base120 := bridgeFixture(120, true)
	base200 := bridgeFixture(200, true)
	seven := generateBGNBDSample(rand.New(rand.NewSource(7)), Params{R: 0.6, Alpha: 3.0, A: 1.0, B: 2.0}, 40, 1000)
	fortyTwo := generateBGNBDSample(rand.New(rand.NewSource(42)), Params{R: 0.8, Alpha: 2.0, A: 0.5, B: 3.0}, 52, 4000)
	ridge := fitted(base120)
	for _, tc := range []struct {
		name      string
		at        Params
		summaries []CustomerSummary
		onRidge   bool
	}{
		{"bridge base, 120 customers", ridge, base120, true},
		{"bridge base, 200 customers", fitted(base200), base200, true},
		{"bridge base, 1200 customers", ridge, bridgeFixture(1200, true), true},
		{"bridge base, 120 customers at Weight 100", ridge, withWeight(base120, 100), true},
		{"synthetic, seed 7", fitted(seven), seven, false},
		{"synthetic, seed 42", fitted(fortyTwo), fortyTwo, false},
	} {
		scale := logLikelihoodRoundingScale(tc.at, tc.summaries)
		got := measuredRounding(tc.at, tc.summaries)
		if !(got <= roundingFloorFactor*scale/2) {
			t.Errorf("%s: measured rounding %.3g exceeds half the rounding floor, %.3g", tc.name, got, roundingFloorFactor*scale/2)
		}
		if !tc.onRidge {
			continue
		}
		if !(got >= scale/16) {
			t.Errorf("%s: measured rounding %.3g is below a sixteenth of the scale %.3g, so the scale overstates it", tc.name, got, scale)
		}
		if !(got > 1000*defaultTolerance) {
			t.Errorf("%s: measured rounding %.3g, want over 1000 times the default tolerance", tc.name, got)
		}
	}
}
