// SPDX-License-Identifier: AGPL-3.0-only
package predictive_clv

import (
	"math"
	"sort"
)

// MethodOfMomentsSeed produces a starting-point Params for FitBGNBD.
//
// Unlike Pareto/NBD, BG/NBD has no exact closed-form method-of-moments
// estimator in the literature — this is a deliberately simple,
// defensible heuristic used only to seed the optimizer, not a
// statistically efficient estimator in its own right:
//
//   - (r, alpha): treat the repeat-frequency counts x_i as an
//     (approximately) Negative-Binomial sample — the NBD arises from a
//     Poisson(lambda) with lambda ~ Gamma(r, alpha), for which the
//     population moments satisfy Var(x)/Mean(x) = 1 + Mean(x)/r. Given
//     the sample mean/variance of x, invert that identity for r, then
//     recover alpha from r and the mean transaction rate
//     Mean(x)/Mean(T).
//   - (a, b): approximate the dropout-probability mixing distribution's
//     mean via the fraction of customers who never repeat-purchased
//     (x == 0) — the group of customers a churn/dropout model should
//     assign the highest dropout mass to — and set (a, b) as a
//     Beta(a,b) with that mean at a mild concentration of 2, i.e.
//     a = 2*p0, b = 2*(1-p0).
//
// All four outputs are clamped to a safe strictly-positive range so the
// result is always a Params.Valid() seed even on degenerate input
// (e.g. every customer has x == 0).
func MethodOfMomentsSeed(summaries []CustomerSummary) Params {
	var n, sumX, sumT float64
	for _, s := range summaries {
		w := s.weight()
		n += w
		sumX += w * s.X
		sumT += w * s.T
	}
	if n <= 0 || sumT <= 0 {
		return Params{R: 1, Alpha: 1, A: 1, B: 1}
	}
	meanX := sumX / n
	meanT := sumT / n

	var sumSqDev float64
	for _, s := range summaries {
		w := s.weight()
		d := s.X - meanX
		sumSqDev += w * d * d
	}
	// Bias-corrected-ish sample variance; guard n<=1.
	denom := n - 1
	if denom < 1 {
		denom = 1
	}
	varX := sumSqDev / denom

	rate := meanX / meanT
	if rate <= 0 || math.IsNaN(rate) {
		rate = 1e-3
	}

	var r float64
	if varX > meanX && meanX > 0 {
		r = meanX * meanX / (varX - meanX)
	} else {
		// Near/sub-Poisson dispersion: fall back to a moderately
		// large r (low heterogeneity) rather than blowing up.
		r = meanX*2 + 0.5
	}
	r = clipPositive(r, 0.05, 1000)
	alpha := clipPositive(r/rate, 0.05, 100000)

	var zeroWeight, totalWeight float64
	for _, s := range summaries {
		w := s.weight()
		totalWeight += w
		if s.X == 0 {
			zeroWeight += w
		}
	}
	p0 := 0.5
	if totalWeight > 0 {
		p0 = zeroWeight / totalWeight
	}
	if p0 < 0.02 {
		p0 = 0.02
	}
	if p0 > 0.98 {
		p0 = 0.98
	}
	const concentration = 2.0
	a := clipPositive(p0*concentration, 0.05, 1000)
	b := clipPositive((1-p0)*concentration, 0.05, 1000)

	return Params{R: r, Alpha: alpha, A: a, B: b}
}

func clipPositive(v, lo, hi float64) float64 {
	if math.IsNaN(v) || v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// NelderMeadOptions configures NelderMead.
type NelderMeadOptions struct {
	// MaxIterations caps the number of simplex updates. Defaults to
	// 2000 when <= 0.
	MaxIterations int
	// Tolerance is the convergence threshold on the spread
	// (f_worst - f_best) across the simplex. Defaults to 1e-9 when <= 0.
	Tolerance float64
	// InitialStep sizes the initial simplex as a relative
	// perturbation of x0 (or an absolute one, for zero coordinates).
	// Defaults to 0.1 when <= 0.
	InitialStep float64
}

// NelderMead minimizes f over R^n via the standard Nelder-Mead simplex
// algorithm (reflect / expand / contract / shrink with the classic
// coefficients alpha=1, gamma=2, rho=sigma=0.5). It is a derivative-free
// direct-search "hill-climb" method — no gradient/Hessian of f is ever
// needed, which is what makes it usable directly on the BG/NBD
// log-likelihood without deriving its analytic gradient.
//
// Returns the best point found, its function value, and the number of
// iterations actually run.
func NelderMead(f func([]float64) float64, x0 []float64, opts NelderMeadOptions) ([]float64, float64, int) {
	res := nelderMead(f, x0, opts)
	return res.X, res.F, res.Iterations
}

// nelderMeadResult is NelderMead's outcome plus the state of its final
// simplex.
type nelderMeadResult struct {
	X          []float64
	F          float64
	Iterations int
	// Converged reports whether the final simplex's spread of function
	// values is below the tolerance. It is false when MaxIterations ran out
	// first; the returned point is then only the best one visited so far.
	Converged bool
	// Spread is the final simplex's spread of function values: f at the
	// worst vertex minus f at the best. NaN when x0 is empty.
	Spread float64
}

// nelderMead is NelderMead, also reporting the final simplex. The
// iteration is NelderMead's exactly; only the final spread is added.
func nelderMead(f func([]float64) float64, x0 []float64, opts NelderMeadOptions) nelderMeadResult {
	n := len(x0)
	if n == 0 {
		return nelderMeadResult{F: math.NaN(), Spread: math.NaN()}
	}
	maxIter := opts.MaxIterations
	if maxIter <= 0 {
		maxIter = 2000
	}
	tol := opts.Tolerance
	if tol <= 0 {
		tol = 1e-9
	}
	step := opts.InitialStep
	if step <= 0 {
		step = 0.1
	}

	const (
		reflectCoef  = 1.0
		expandCoef   = 2.0
		contractCoef = 0.5
		shrinkCoef   = 0.5
	)

	simplex := make([][]float64, n+1)
	fvals := make([]float64, n+1)
	simplex[0] = append([]float64(nil), x0...)
	for i := 1; i <= n; i++ {
		p := append([]float64(nil), x0...)
		if p[i-1] != 0 {
			p[i-1] *= 1 + step
		} else {
			p[i-1] = step
		}
		simplex[i] = p
	}
	for i := range simplex {
		fvals[i] = f(simplex[i])
	}

	sortSimplex(simplex, fvals)

	iter := 0
	for ; iter < maxIter; iter++ {
		if math.Abs(fvals[n]-fvals[0]) < tol {
			break
		}

		centroid := make([]float64, n)
		for i := 0; i < n; i++ { // all but the worst point (index n)
			for d := 0; d < n; d++ {
				centroid[d] += simplex[i][d]
			}
		}
		for d := range centroid {
			centroid[d] /= float64(n)
		}

		worst := simplex[n]
		xr := reflectPoint(centroid, worst, reflectCoef)
		fr := f(xr)

		switch {
		case fr < fvals[0]:
			xe := make([]float64, n)
			for d := 0; d < n; d++ {
				xe[d] = centroid[d] + expandCoef*(xr[d]-centroid[d])
			}
			fe := f(xe)
			if fe < fr {
				simplex[n], fvals[n] = xe, fe
			} else {
				simplex[n], fvals[n] = xr, fr
			}
		case fr < fvals[n-1]:
			simplex[n], fvals[n] = xr, fr
		default:
			var xc []float64
			var useOutside bool
			if fr < fvals[n] {
				useOutside = true
			}
			xc = make([]float64, n)
			for d := 0; d < n; d++ {
				if useOutside {
					xc[d] = centroid[d] + contractCoef*(xr[d]-centroid[d])
				} else {
					xc[d] = centroid[d] + contractCoef*(worst[d]-centroid[d])
				}
			}
			fc := f(xc)
			betterThan := fvals[n]
			if useOutside && fr < betterThan {
				betterThan = fr
			}
			if fc < betterThan {
				simplex[n], fvals[n] = xc, fc
			} else {
				best := simplex[0]
				for i := 1; i <= n; i++ {
					for d := 0; d < n; d++ {
						simplex[i][d] = best[d] + shrinkCoef*(simplex[i][d]-best[d])
					}
					fvals[i] = f(simplex[i])
				}
			}
		}

		sortSimplex(simplex, fvals)
	}

	spread := math.Abs(fvals[n] - fvals[0])
	return nelderMeadResult{
		X:          simplex[0],
		F:          fvals[0],
		Iterations: iter,
		Converged:  spread < tol,
		Spread:     spread,
	}
}

func reflectPoint(centroid, worst []float64, coef float64) []float64 {
	out := make([]float64, len(centroid))
	for d := range out {
		out[d] = centroid[d] + coef*(centroid[d]-worst[d])
	}
	return out
}

func sortSimplex(simplex [][]float64, fvals []float64) {
	idx := make([]int, len(fvals))
	for i := range idx {
		idx[i] = i
	}
	sort.Slice(idx, func(i, j int) bool { return fvals[idx[i]] < fvals[idx[j]] })

	sortedSimplex := make([][]float64, len(simplex))
	sortedFvals := make([]float64, len(fvals))
	for newPos, oldPos := range idx {
		sortedSimplex[newPos] = simplex[oldPos]
		sortedFvals[newPos] = fvals[oldPos]
	}
	copy(simplex, sortedSimplex)
	copy(fvals, sortedFvals)
}

// FitOptions configures FitBGNBD.
type FitOptions struct {
	MaxIterations int
	Tolerance     float64
	// Seed overrides MethodOfMomentsSeed when non-nil.
	Seed *Params
}

// FitResult is the outcome of a FitBGNBD call.
type FitResult struct {
	Params        Params
	LogLikelihood float64
	Iterations    int
	// Converged reports whether Nelder-Mead met its tolerance before
	// MaxIterations ran out.
	Converged bool
	// Spread is the final simplex's spread of log-likelihood values: the
	// best vertex's minus the worst's. When Converged is false, FitBGNBD
	// accepts the fit only if Spread is within the rounding floor of the
	// log-likelihood at Params. The simplex has then settled as far as
	// float64 can resolve, short of a tolerance that rounding error
	// exceeds (see checkConverged in fitguard.go).
	Spread float64
}

// FitBGNBD estimates (r, alpha, a, b) by maximizing LogLikelihood over
// summaries, via Nelder-Mead on the log-transformed parameters
// (theta = ln(r), ln(alpha), ln(a), ln(b)). Working in log-space keeps
// every point the simplex visits inside the model's strictly-positive
// domain without needing constrained-optimization machinery.
//
// FitBGNBD returns a *FitError (wrapping ErrFitRejected) instead of a fit
// whose parameters would be meaningless. It checks the input before
// optimizing: a malformed summary, or data for which the likelihood has no
// maximum, is rejected without running the optimizer. It then checks the
// optimizer's best point: a non-finite likelihood, parameters outside the
// range double precision can resolve, a likelihood above the data's upper
// bound, or a search that ran out of iterations while still climbing. A
// search that ran out of iterations only because rounding error in the
// likelihood exceeds Nelder-Mead's tolerance has settled, and is accepted.
// fitguard.go documents each check. When one of those outcome checks fails,
// the returned FitResult still describes the rejected fit so a caller can
// log it, but its Params must not be used for forecasting. A fit that
// passes is returned exactly as the optimizer found it.
func FitBGNBD(summaries []CustomerSummary, opts FitOptions) (FitResult, error) {
	if err := validateSummaries(summaries); err != nil {
		return FitResult{}, err
	}
	res := optimizeBGNBD(summaries, opts)
	if err := assessFit(res, summaries); err != nil {
		return res, err
	}
	return res, nil
}

// optimizeBGNBD runs the maximum-likelihood search for FitBGNBD and returns
// its best point without judging it. summaries must be non-empty.
func optimizeBGNBD(summaries []CustomerSummary, opts FitOptions) FitResult {
	seed := MethodOfMomentsSeed(summaries)
	if opts.Seed != nil {
		seed = *opts.Seed
	}
	if !seed.Valid() {
		seed = Params{R: 1, Alpha: 1, A: 1, B: 1}
	}

	x0 := []float64{
		math.Log(seed.R),
		math.Log(seed.Alpha),
		math.Log(seed.A),
		math.Log(seed.B),
	}

	const penalty = 1e12
	negLogLik := func(theta []float64) float64 {
		p := Params{
			R:     math.Exp(theta[0]),
			Alpha: math.Exp(theta[1]),
			A:     math.Exp(theta[2]),
			B:     math.Exp(theta[3]),
		}
		if !p.Valid() {
			return penalty
		}
		ll := LogLikelihood(p, summaries)
		if math.IsNaN(ll) || math.IsInf(ll, 0) {
			return penalty
		}
		return -ll
	}

	nmOpts := NelderMeadOptions{
		MaxIterations: opts.MaxIterations,
		Tolerance:     opts.Tolerance,
		InitialStep:   0.25,
	}
	nm := nelderMead(negLogLik, x0, nmOpts)
	thetaBest := nm.X

	fitted := Params{
		R:     math.Exp(thetaBest[0]),
		Alpha: math.Exp(thetaBest[1]),
		A:     math.Exp(thetaBest[2]),
		B:     math.Exp(thetaBest[3]),
	}

	return FitResult{
		Params:        fitted,
		LogLikelihood: -nm.F,
		Iterations:    nm.Iterations,
		Converged:     nm.Converged,
		Spread:        nm.Spread,
	}
}
