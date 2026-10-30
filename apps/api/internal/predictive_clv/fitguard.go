// SPDX-License-Identifier: AGPL-3.0-only
package predictive_clv

import (
	"errors"
	"fmt"
	"math"
)

// ErrFitRejected is wrapped by every error FitBGNBD returns: the input
// cannot be fit, or the optimizer's best point is not a usable estimate.
// Match it with errors.Is. errors.As with a *FitError gives the reason.
var ErrFitRejected = errors.New("predictive_clv: BG/NBD fit rejected")

// FitRejectReason names the check a rejected fit failed.
type FitRejectReason string

// Input checks. FitBGNBD makes these before the optimizer runs.
const (
	// RejectInvalidInput means there are no summaries, or a summary lies
	// outside the model's domain: a non-finite field, T <= 0, X < 0 or
	// 0 < X < 1, or Tx outside [0, T]. X counts repeat transactions, and the
	// likelihood's ln(b+X-1) term needs X = 0 or X >= 1.
	RejectInvalidInput FitRejectReason = "invalid_input"
	// RejectUnboundedLikelihood means a summary has X > 0 repeat
	// transactions at Tx = 0. The likelihood then has no upper bound: along
	// alpha -> 0 that customer's term grows like X*ln(1/alpha), so no
	// maximum-likelihood fit exists and the optimizer runs alpha down to
	// floating-point underflow. Transactions at the first purchase's instant
	// belong to that purchase, which gives X = 0.
	RejectUnboundedLikelihood FitRejectReason = "unbounded_likelihood"
	// RejectNoRepeatTransactions means no summary has X > 0. The likelihood
	// then rises toward a zero purchase rate without reaching a maximum, and
	// it does not depend on a or b at all.
	RejectNoRepeatTransactions FitRejectReason = "no_repeat_transactions"
)

// Outcome checks. FitBGNBD makes these on the optimizer's best point, in
// this order, and reports the first that fails.
const (
	// RejectNonFiniteLikelihood means a fitted parameter under- or
	// overflowed, or the log-likelihood at the fitted point is NaN or
	// infinite.
	RejectNonFiniteLikelihood FitRejectReason = "non_finite_likelihood"
	// RejectParamsOutOfRange means a parameter left the range double
	// precision can resolve against the data. See maxAbsLogParam.
	RejectParamsOutOfRange FitRejectReason = "params_out_of_range"
	// RejectImpossibleLikelihood means the log-likelihood exceeds the upper
	// bound the data put on it, which only a numerical breakdown can
	// produce. See logLikelihoodUpperBound.
	RejectImpossibleLikelihood FitRejectReason = "impossible_likelihood"
	// RejectNotConverged means Nelder-Mead used every iteration it was
	// allowed, and its final simplex still spans more log-likelihood than
	// rounding error can explain. The search was still climbing when it
	// stopped. See checkConverged.
	RejectNotConverged FitRejectReason = "not_converged"
)

// FitError reports why FitBGNBD rejected a fit.
type FitError struct {
	Reason FitRejectReason
	// Detail says what failed, with the values involved.
	Detail string
}

func (e *FitError) Error() string {
	return fmt.Sprintf("%v (%s): %s", ErrFitRejected, e.Reason, e.Detail)
}

// Unwrap makes errors.Is(err, ErrFitRejected) hold for every FitError.
func (e *FitError) Unwrap() error { return ErrFitRejected }

func rejectf(reason FitRejectReason, format string, args ...any) error {
	return &FitError{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// maxAbsLogParam bounds each fitted parameter in dimensionless log space:
// |ln r|, |ln a|, |ln b| and |ln(alpha/tau)| must be at most 52*ln 2 (about
// 36.04), where tau is the weighted mean observation length T. alpha is a
// rate in the caller's time unit, so measuring it against tau makes the
// bound independent of that unit. r, a and b have no unit.
//
// The bound is the 52-bit significand of a float64, not a statistical
// prior. Beyond it a parameter can no longer be resolved against the data:
//
//   - A large parameter v enters the likelihood as lnGamma(v+x) -
//     lnGamma(v), which is about x*ln(v). Each lnGamma carries a rounding
//     error of about eps*v*ln(v), and for a single transaction (x = 1) that
//     error reaches the difference itself at v = 1/eps = 2^52. No
//     significant bit of the data's contribution is left.
//   - A small parameter vanishes in the sums it enters (r+x, a+b+x,
//     alpha+T): at 2^-52 of their size it is one unit in the last place.
//     The likelihood then depends on it only through its logarithm, and a
//     likelihood with no interior maximum runs away along that direction.
//
// The diverged fit this guard was written for had alpha = 5e-324, so
// ln(alpha/tau) was about -748. Legitimate fits sit far inside the bound.
// The canonical CDNOW fit has every |ln| below 2.5. When dropout is nearly
// the same for every customer, a and b drift toward the Beta distribution's
// point-mass limit; this repo's fixtures of that kind stop near e^17.
const maxAbsLogParam = 52 * math.Ln2

// likelihoodBoundSlack is the relative margin checkLikelihoodBound allows
// for rounding before it calls a log-likelihood above the data's bound
// impossible. A correctly evaluated log-likelihood can exceed the bound
// only by accumulated rounding, which stays orders of magnitude below 1e-6
// of the terms' size wherever lnGamma keeps most of its precision. Near the
// edge of maxAbsLogParam, lnGamma's rounding alone is several units per
// customer, which this margin does not absorb.
const likelihoodBoundSlack = 1e-6

// roundingFloorFactor turns logLikelihoodRoundingScale into the rounding
// floor that checkConverged compares a simplex's spread with. To first
// order, rounding moves one evaluation of LogLikelihood by at most twice
// the scale's part for the terms, and half its part for the running totals.
// The terms are each correct to about an ulp, and the partial sums inside
// LogLikelihoodSingle are no larger than the terms. So one evaluation moves
// by at most twice the scale, and a spread, which compares two evaluations,
// by at most 4 times the scale. The spreads of simplexes that settled at
// the floor measure below a third of it on darwin/arm64 and on linux/amd64
// (fitguard_test.go).
const roundingFloorFactor = 4

// validateSummaries makes FitBGNBD's input checks.
func validateSummaries(summaries []CustomerSummary) error {
	if len(summaries) == 0 {
		return rejectf(RejectInvalidInput, "FitBGNBD requires at least one customer summary")
	}
	repeaters, zeroRecency, firstZeroRecency := 0, 0, -1
	for i, s := range summaries {
		if err := validateSummary(i, s); err != nil {
			return err
		}
		if s.X == 0 {
			continue
		}
		repeaters++
		if s.Tx == 0 {
			if zeroRecency == 0 {
				firstZeroRecency = i
			}
			zeroRecency++
		}
	}
	if zeroRecency > 0 {
		return rejectf(RejectUnboundedLikelihood,
			"%d of %d summaries (the first at index %d) have X > 0 repeat transactions at Tx = 0, "+
				"so the likelihood grows without bound as alpha -> 0 and has no maximum",
			zeroRecency, len(summaries), firstZeroRecency)
	}
	if repeaters == 0 {
		return rejectf(RejectNoRepeatTransactions,
			"none of the %d summaries has a repeat transaction (X > 0), so the likelihood "+
				"rises toward a zero purchase rate and has no maximum", len(summaries))
	}
	return nil
}

// validateSummary checks one summary against the model's domain. Tx is
// not checked against X: it is ignored when X = 0.
func validateSummary(i int, s CustomerSummary) error {
	switch {
	case !isFinite(s.X) || !isFinite(s.Tx) || !isFinite(s.T) || !isFinite(s.Weight):
		return rejectf(RejectInvalidInput, "summary %d has a non-finite field: %+v", i, s)
	case s.T <= 0:
		return rejectf(RejectInvalidInput, "summary %d has T = %g; the observation length must be positive", i, s.T)
	case s.X < 0 || (s.X > 0 && s.X < 1):
		return rejectf(RejectInvalidInput, "summary %d has X = %g; a repeat-transaction count is 0 or at least 1", i, s.X)
	case s.Tx < 0 || s.Tx > s.T:
		return rejectf(RejectInvalidInput, "summary %d has Tx = %g outside [0, T = %g]", i, s.Tx, s.T)
	}
	return nil
}

// assessFit makes FitBGNBD's outcome checks on res, the optimizer's best
// point for summaries (which passed validateSummaries).
func assessFit(res FitResult, summaries []CustomerSummary) error {
	if err := checkFinite(res, summaries); err != nil {
		return err
	}
	if err := checkParamRange(res.Params, meanObservationLength(summaries)); err != nil {
		return err
	}
	if err := checkLikelihoodBound(res.LogLikelihood, summaries); err != nil {
		return err
	}
	return checkConverged(res, summaries)
}

// checkFinite rejects a fit whose params or log-likelihood are not finite.
// The optimizer scores a point where the likelihood is not finite with a
// finite penalty, so a search that never reached a finite point still
// reports a finite LogLikelihood. The likelihood is therefore re-evaluated
// at the fitted params.
func checkFinite(res FitResult, summaries []CustomerSummary) error {
	if !res.Params.Valid() {
		return rejectf(RejectNonFiniteLikelihood,
			"fitted params %+v left the model's domain (a parameter under- or overflowed)", res.Params)
	}
	if !isFinite(res.LogLikelihood) {
		return rejectf(RejectNonFiniteLikelihood, "fitted log-likelihood is %g (params %+v)", res.LogLikelihood, res.Params)
	}
	if ll := LogLikelihood(res.Params, summaries); !isFinite(ll) {
		return rejectf(RejectNonFiniteLikelihood, "log-likelihood at the fitted params %+v is %g", res.Params, ll)
	}
	return nil
}

// checkParamRange rejects params outside maxAbsLogParam. tau is the time
// scale alpha is measured against (meanObservationLength).
func checkParamRange(p Params, tau float64) error {
	logs := [...]struct {
		name  string
		value float64
	}{
		{"ln r", math.Log(p.R)},
		// A difference of logs, so an alpha near underflow still reports
		// its magnitude instead of ln(0).
		{"ln(alpha/tau)", math.Log(p.Alpha) - math.Log(tau)},
		{"ln a", math.Log(p.A)},
		{"ln b", math.Log(p.B)},
	}
	for _, l := range logs {
		// Written so that NaN fails too.
		if !(math.Abs(l.value) <= maxAbsLogParam) {
			return rejectf(RejectParamsOutOfRange,
				"%s = %.4g is outside [-%.4g, %.4g] (params %+v; tau = %.4g is the mean observation length T)",
				l.name, l.value, maxAbsLogParam, maxAbsLogParam, p, tau)
		}
	}
	return nil
}

// meanObservationLength is the weighted mean of T.
func meanObservationLength(summaries []CustomerSummary) float64 {
	var sumWT, sumW float64
	for _, s := range summaries {
		w := s.weight()
		sumWT += w * s.T
		sumW += w
	}
	return sumWT / sumW
}

// checkLikelihoodBound rejects a log-likelihood above the data's upper
// bound by more than rounding can explain.
func checkLikelihoodBound(ll float64, summaries []CustomerSummary) error {
	bound, scale := logLikelihoodUpperBound(summaries)
	if ll-bound > likelihoodBoundSlack*(1+scale+math.Abs(ll)) {
		return rejectf(RejectImpossibleLikelihood,
			"log-likelihood %.6g exceeds %.6g, the most any parameters can give this data, "+
				"so its evaluation broke down numerically", ll, bound)
	}
	return nil
}

// logLikelihoodUpperBound returns a bound that LogLikelihood(p, summaries)
// cannot exceed for any p, and the sum of its terms' magnitudes (the scale
// for rounding). summaries must have passed validateSummaries.
//
// A customer's BG/NBD likelihood is the individual-level likelihood
//
//	L(lambda, p) = (1-p)^x lambda^x e^(-lambda T) + 1{x>0} p (1-p)^(x-1) lambda^x e^(-lambda t_x)
//
// averaged over lambda ~ Gamma(r, alpha) and p ~ Beta(a, b), so it cannot
// exceed that function's supremum over lambda and p. For x = 0 the
// supremum is 1, approached as lambda -> 0. For x >= 1, t_x <= T gives
// L <= (1-p)^(x-1) lambda^x e^(-lambda t_x) <= lambda^x e^(-lambda t_x),
// which is largest at lambda = x/t_x. Hence
//
//	ln L <= 0                    for x = 0
//	ln L <= x*(ln(x/t_x) - 1)    for x >= 1 and t_x > 0
//
// The bound is not 0. The likelihood is a density in continuous time
// (lambda^x has units of time^-x), so frequent buyers measured in a coarse
// time unit have a positive log-likelihood, legitimately. A summary with
// x > 0 and t_x = 0 has no bound at all, which is why validateSummaries
// rejects it.
func logLikelihoodUpperBound(summaries []CustomerSummary) (bound, scale float64) {
	for _, s := range summaries {
		if s.X == 0 {
			continue
		}
		term := s.weight() * s.X * (math.Log(s.X/s.Tx) - 1)
		bound += term
		scale += math.Abs(term)
	}
	return bound, scale
}

// checkConverged rejects a search that used its whole budget while it was
// still climbing.
//
// Nelder-Mead stops when the spread of the log-likelihood across its
// simplex falls below an absolute tolerance, 1e-9 by default. That test
// assumes the log-likelihood can be evaluated more finely than the
// tolerance. A simplex still wider than the tolerance when the budget runs
// out is then still climbing. The assumption fails when dropout, or the
// purchase rate, is nearly the same for every customer. The likelihood then
// rises toward a boundary where a and b (or r and alpha) grow without bound
// at a fixed ratio, along a ridge that is flat to within rounding error.
// Near a = e^15, LogLikelihoodSingle subtracts lnGamma values of several
// times 10^8 to get a result of order 1. The log-likelihood of a few hundred
// such customers therefore carries rounding error near 10^-4, which is 10^5
// times the tolerance. The simplex settles at that floor and from then on
// moves on rounding noise. Whether its spread ever drops below the tolerance
// is then chance. It depends on the number of customers, their row order,
// the Weight encoding and the CPU architecture, and the fits that pass and
// the fits that fail that way forecast alike to within 0.03%. The
// assumption also weakens as a base grows, because the rounding of the sum
// over customers grows with it: for 4000 well-conditioned customers it is
// already close to the tolerance.
//
// So a search that used its whole budget is accepted when its final spread
// is within the rounding floor of the log-likelihood at its best point:
// roundingFloorFactor times logLikelihoodRoundingScale. Its vertices then
// differ by no more than rounding can explain, so no further improvement is
// measurable. A search stopped while still climbing spans orders of
// magnitude more than its floor.
func checkConverged(res FitResult, summaries []CustomerSummary) error {
	if res.Converged {
		return nil
	}
	floor := roundingFloorFactor * logLikelihoodRoundingScale(res.Params, summaries)
	// Written so that a NaN spread or floor fails too.
	if res.Spread <= floor {
		return nil
	}
	return rejectf(RejectNotConverged,
		"Nelder-Mead used all %d iterations and its final simplex still spans %.3g in log-likelihood, "+
			"above both its tolerance and %.3g, the rounding floor of the log-likelihood there; best point so far %+v",
		res.Iterations, res.Spread, floor, res.Params)
}

// logLikelihoodRoundingScale returns the scale of the rounding error in
// LogLikelihood(p, summaries): float64Epsilon times the sum of the
// magnitudes that the evaluation rounds. The sum has two parts:
//
//   - The magnitude of every term LogLikelihoodSingle adds or subtracts,
//     times the customer's weight. Where terms cancel, as lnGamma(a+b) and
//     lnGamma(a+b+x) do when a and b are large, the result shrinks but each
//     term's rounding error remains.
//   - The magnitude of each running total LogLikelihood forms. That bounds
//     the rounding of the sum over customers (Higham, Accuracy and
//     Stability of Numerical Algorithms, 2nd ed., section 4.2).
//
// The terms mirror LogLikelihoodSingle's, and must change when its
// arithmetic does. TestLogLikelihoodRoundingScale_TracksTheMeasuredRounding
// fails when the two drift apart.
func logLikelihoodRoundingScale(p Params, summaries []CustomerSummary) float64 {
	r, alpha, a, b := p.R, p.Alpha, p.A, p.B
	// The terms that do not depend on the customer.
	shared := math.Abs(lnGamma(r)) + math.Abs(r*math.Log(alpha)) + math.Abs(lnGamma(a+b)) + math.Abs(lnGamma(b))
	lnA := math.Abs(math.Log(a))
	var sum, total float64
	for _, s := range summaries {
		x, w := s.X, s.weight()
		terms := shared + math.Abs(lnGamma(r+x)) + math.Abs(lnGamma(b+x)) + math.Abs(lnGamma(a+b+x)) +
			math.Abs((r+x)*math.Log(alpha+s.T))
		if x > 0 {
			terms += lnA + math.Abs(math.Log(b+x-1)) + math.Abs((r+x)*math.Log(alpha+s.Tx))
		}
		total += w * LogLikelihoodSingle(p, x, s.Tx, s.T)
		sum += w*terms + math.Abs(total)
	}
	return float64Epsilon * sum
}

// float64Epsilon is the gap between 1 and the next larger float64, 2^-52.
const float64Epsilon = 0x1p-52

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
