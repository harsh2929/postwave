// SPDX-License-Identifier: AGPL-3.0-only
//
// clv_bgnbd.go — the BG/NBD bridge (G-11): turn the per-customer order
// signals this package already gathers (ProfileSignals: order count, first/
// last order timestamps, historic spend) into the committed
// internal/predictive_clv Beta-Geometric/NBD model's inputs, fit the
// population parameters once per tenant, and score each customer's expected
// future transactions + CLV.
//
// This is the real statistical replacement for ComputePrediction's
// `predictedOrders(...)` heuristic ("heuristic-v1"): where the heuristic
// extrapolates avg-days-between-orders × a churn discount, BG/NBD is the
// standard "buy-till-you-die" model (Fader/Hardie/Lee 2005) that jointly
// estimates purchase frequency and the latent dropout process from the whole
// customer base, then conditions each customer's forecast on their own
// recency/frequency. The extraction already exists (repo.go builds
// ProfileSignals from commerce_orders); this file is only the model bridge.
//
// The functions are pure (no DB, no clock beyond the caller-supplied `now`)
// so they unit-test deterministically. Repo.Recompute fits once per tenant
// through PredictBatchBGNBD (clv_bgnbd_batch.go) and records the fit's
// outcome in the run's metrics.
package predictive

import (
	"errors"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/predictive_clv"
)

// bgnbdWeek is the BG/NBD time unit. The model is unit-agnostic as long as
// the unit is consistent across x/t_x/T and the forecast horizon; weeks
// match the CDNOW literature the model was validated against.
const bgnbdWeek = 7 * 24 * time.Hour

// MinCustomersForBGNBD is the population size below which a per-tenant MLE
// fit is too unstable to trust; FitTenantBGNBD reports
// ErrTooFewCustomersForBGNBD and the caller should fall back to the
// heuristic. 50 is a conservative floor — below it the four-parameter fit
// routinely chases sampling noise.
const MinCustomersForBGNBD = 50

// ErrTooFewCustomersForBGNBD is FitTenantBGNBD's error when fewer than
// MinCustomersForBGNBD customers have a scorable summary.
var ErrTooFewCustomersForBGNBD = errors.New("predictive: too few scorable customers to fit BG/NBD")

// BGNBDFallbackTooFewCustomers is BGNBDFit.FallbackReason for
// ErrTooFewCustomersForBGNBD. Every other reason FitTenantBGNBD produces is
// the predictive_clv.FitRejectReason of FitBGNBD's rejection.
const BGNBDFallbackTooFewCustomers = "too_few_customers"

// bgnbdFallbackUnclassified is BGNBDFit.FallbackReason for an error that is
// neither of the above. FitTenantBGNBD never produces one; the label keeps
// FallbackReason total for a BGNBDFit built elsewhere.
const bgnbdFallbackUnclassified = "fit_error"

// BGNBDFit is the outcome of FitTenantBGNBD.
type BGNBDFit struct {
	// Params are the fitted population parameters. They are the zero Params
	// unless Err is nil: a rejected fit's parameters must not be used.
	Params predictive_clv.Params
	// Customers is how many customers had a scorable summary (see
	// SignalToSummary), which is how many the fit saw.
	Customers int
	// Err is nil when the model was fitted. Otherwise the caller keeps the
	// heuristic, and Err says why: it wraps ErrTooFewCustomersForBGNBD, or it
	// is the *predictive_clv.FitError FitBGNBD rejected the fit with.
	Err error
}

// Fitted reports whether Params are a fit to forecast from.
func (f BGNBDFit) Fitted() bool { return f.Err == nil }

// FallbackReason names why the heuristic was kept, as a stable label for
// logs and run metrics: "" when the model was fitted,
// BGNBDFallbackTooFewCustomers when the base was too small, and otherwise the
// predictive_clv.FitRejectReason FitBGNBD rejected the fit with.
func (f BGNBDFit) FallbackReason() string {
	var fitErr *predictive_clv.FitError
	switch {
	case f.Err == nil:
		return ""
	case errors.Is(f.Err, ErrTooFewCustomersForBGNBD):
		return BGNBDFallbackTooFewCustomers
	case errors.As(f.Err, &fitErr):
		return string(fitErr.Reason)
	default:
		return bgnbdFallbackUnclassified
	}
}

// dataCannotSupportFit reports whether f fell back because the tenant's data
// cannot support a BG/NBD fit at all: too few customers, or none who bought
// again. Both are ordinary states of a small or new store. Every other
// rejection means the fit was attempted on data that supports it and broke
// down, which an operator should look into.
func (f BGNBDFit) dataCannotSupportFit() bool {
	switch f.FallbackReason() {
	case BGNBDFallbackTooFewCustomers, string(predictive_clv.RejectNoRepeatTransactions):
		return true
	default:
		return false
	}
}

// DefaultCLVHorizonWeeks is the forward window BGNBDForecast projects over
// when the caller does not specify one (52 weeks ≈ the 365-day window the
// heuristic Recompute path already uses).
const DefaultCLVHorizonWeeks = 52.0

// SignalToSummary maps one customer's order signals to a BG/NBD
// CustomerSummary as of `now`. It returns ok=false for a customer who can't
// form a valid summary: no orders, no first-order timestamp, or an
// observation window (T) that isn't strictly positive.
//
//   - x  (repeat transactions) = OrderCount - 1. BG/NBD counts the initial
//     purchase as the start of the relationship, not a repeat, so a
//     single-order customer has x=0 (and is still informative — they
//     constrain the dropout parameters).
//   - t_x (recency) = LastOrderAt - FirstOrderAt, in weeks. A single-order
//     customer (or one whose last order timestamp is missing) has t_x=0.
//   - T   (age)     = now - FirstOrderAt, in weeks.
//
// x and t_x are kept consistent: when t_x is 0 there is no observable repeat
// transaction, so x is 0 too, whatever OrderCount says. BG/NBD's repeat
// transactions happen strictly after the first purchase; orders that share
// the first order's instant (a split checkout, a date-only import), or whose
// last-order timestamp is missing or earlier than the first, form one
// purchase occasion. This is the period-aggregation convention the model's
// literature uses, and it is load-bearing rather than cosmetic. For a summary
// with x > 0 and t_x = 0 the likelihood's (alpha+t_x)^-(r+x) factor becomes
// alpha^-(r+x), so it grows without bound as alpha -> 0: x repeats in zero
// elapsed time are best "explained" by an infinite purchase rate. Such rows
// let the MLE run alpha down to floating-point underflow, and every forecast
// made from those params is rounding noise that differs between CPU
// architectures.
func SignalToSummary(signal ProfileSignals, now time.Time) (predictive_clv.CustomerSummary, bool) {
	if signal.OrderCount < 1 || signal.FirstOrderAt == nil {
		return predictive_clv.CustomerSummary{}, false
	}
	T := now.Sub(*signal.FirstOrderAt).Hours() / bgnbdWeek.Hours()
	if T <= 0 {
		// First order in the future / same instant as now — no observable
		// window, so the customer can't be scored (or fit against).
		return predictive_clv.CustomerSummary{}, false
	}
	tx := 0.0
	if signal.LastOrderAt != nil {
		tx = signal.LastOrderAt.Sub(*signal.FirstOrderAt).Hours() / bgnbdWeek.Hours()
	}
	if tx < 0 {
		tx = 0 // defensive: last before first is nonsensical, treat as no repeat recency
	}
	if tx > T {
		tx = T // t_x can never exceed the observation window
	}
	x := float64(signal.OrderCount - 1)
	if tx == 0 {
		x = 0 // no elapsed repeat window: one purchase occasion (see above)
	}
	return predictive_clv.CustomerSummary{
		X:  x,
		Tx: tx,
		T:  T,
	}, true
}

// FitTenantBGNBD builds a summary for every scorable customer in signals and
// fits the population BG/NBD parameters (r, alpha, a, b) by MLE. The result
// says how many customers contributed and, when the caller must keep the
// heuristic, why: the base is too small (< MinCustomersForBGNBD), or FitBGNBD
// rejected the fit. A caller should record BGNBDFit.FallbackReason, because
// each fallback changes the model a tenant's forecasts come from.
// Single-order (x=0) customers are deliberately included: excluding them
// biases the dropout estimate.
func FitTenantBGNBD(signals []ProfileSignals, now time.Time) BGNBDFit {
	return fitTenantBGNBD(signals, now, predictive_clv.FitOptions{})
}

// fitTenantBGNBD is FitTenantBGNBD with FitBGNBD's options exposed, so tests
// can drive the real fitter into its outcome rejections.
func fitTenantBGNBD(signals []ProfileSignals, now time.Time, opts predictive_clv.FitOptions) BGNBDFit {
	summaries := make([]predictive_clv.CustomerSummary, 0, len(signals))
	for _, s := range signals {
		if sum, ok := SignalToSummary(s, now); ok {
			summaries = append(summaries, sum)
		}
	}
	fit := BGNBDFit{Customers: len(summaries)}
	if len(summaries) < MinCustomersForBGNBD {
		fit.Err = fmt.Errorf("%w: %d scorable customers, %d needed",
			ErrTooFewCustomersForBGNBD, len(summaries), MinCustomersForBGNBD)
		return fit
	}
	// FitBGNBD returns a nil error only for params that passed every outcome
	// check, the first of which rejects params outside the model's domain
	// (Params.Valid), so they are safe to forecast from.
	res, err := predictive_clv.FitBGNBD(summaries, opts)
	if err != nil {
		fit.Err = err
		return fit
	}
	fit.Params = res.Params
	return fit
}

// BGNBDForecast is a single customer's model-based forecast: expected number
// of transactions over the horizon, and the CLV that implies given their
// average historic order value.
type BGNBDForecast struct {
	PredictedOrders   float64
	PredictedCLVCents int
}

// BGNBDForecastFor conditions the fitted population params on one customer's
// own recency/frequency to project their expected transactions over
// horizonWeeks, then multiplies by their average historic spend per purchase
// occasion to get predicted CLV in cents. An occasion is a transaction as the
// model counts it (x+1 of them), which is one per order except when
// SignalToSummary merges same-instant orders into one occasion. Dividing by
// the order count there would cut the customer's per-occasion spend by the
// number of merged orders. ok=false means the customer has no scorable
// summary (see SignalToSummary), and the caller should fall back.
//
// Caller shape (PredictBatchBGNBD, replacing the heuristic branch):
//
//	fit := FitTenantBGNBD(allSignals, now)   // once per tenant
//	...
//	if fit.Fitted() {
//	    if f, ok := BGNBDForecastFor(fit.Params, signal, now, DefaultCLVHorizonWeeks); ok {
//	        predictedOrders = f.PredictedOrders
//	        predictedCLVCents = f.PredictedCLVCents        // model == "bgnbd-v1"
//	    }
//	}
func BGNBDForecastFor(params predictive_clv.Params, signal ProfileSignals, now time.Time, horizonWeeks float64) (BGNBDForecast, bool) {
	summary, ok := SignalToSummary(signal, now)
	if !ok {
		return BGNBDForecast{}, false
	}
	if horizonWeeks <= 0 {
		horizonWeeks = DefaultCLVHorizonWeeks
	}
	predictedOrders := predictive_clv.ConditionalExpectedTransactions(
		params, horizonWeeks, summary.X, summary.Tx, summary.T)
	if predictedOrders < 0 {
		predictedOrders = 0
	}
	// summary.X+1 >= 1 always (SignalToSummary never yields a negative x), and
	// equals OrderCount whenever no orders were merged into one occasion.
	avgOccasionValue := float64(signal.HistoricCLVCents) / (summary.X + 1)
	clvCents := int(avgOccasionValue*predictedOrders + 0.5)
	return BGNBDForecast{PredictedOrders: predictedOrders, PredictedCLVCents: clvCents}, true
}
