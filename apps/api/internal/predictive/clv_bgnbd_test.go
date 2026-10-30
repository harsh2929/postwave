// SPDX-License-Identifier: AGPL-3.0-only
package predictive

import (
	"math"
	"testing"
	"time"
)

var bgnbdNow = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func weeksAgo(w float64) *time.Time {
	t := bgnbdNow.Add(-time.Duration(w * float64(bgnbdWeek)))
	return &t
}

func TestSignalToSummary(t *testing.T) {
	// A repeat customer: first order 40 weeks ago, last 10 weeks ago, 5 orders.
	sum, ok := SignalToSummary(ProfileSignals{
		OrderCount: 5, FirstOrderAt: weeksAgo(40), LastOrderAt: weeksAgo(10),
	}, bgnbdNow)
	if !ok {
		t.Fatal("valid repeat customer should produce a summary")
	}
	if sum.X != 4 { // OrderCount-1
		t.Errorf("x = %v, want 4 (repeat transactions)", sum.X)
	}
	if math.Abs(sum.T-40) > 1e-6 {
		t.Errorf("T = %v, want 40 weeks (age)", sum.T)
	}
	if math.Abs(sum.Tx-30) > 1e-6 { // last(10 ago) - first(40 ago) = 30 weeks
		t.Errorf("t_x = %v, want 30 weeks (recency)", sum.Tx)
	}

	// Single-order customer: x=0, t_x=0, still scorable.
	sum, ok = SignalToSummary(ProfileSignals{
		OrderCount: 1, FirstOrderAt: weeksAgo(12), LastOrderAt: weeksAgo(12),
	}, bgnbdNow)
	if !ok || sum.X != 0 || sum.Tx != 0 || math.Abs(sum.T-12) > 1e-6 {
		t.Fatalf("single-order summary wrong: %+v ok=%v", sum, ok)
	}

	// Single order with nil LastOrderAt → t_x=0.
	sum, ok = SignalToSummary(ProfileSignals{
		OrderCount: 1, FirstOrderAt: weeksAgo(8), LastOrderAt: nil,
	}, bgnbdNow)
	if !ok || sum.Tx != 0 {
		t.Fatalf("nil last-order should give t_x=0: %+v ok=%v", sum, ok)
	}

	// Guards: no orders, no first-order timestamp, future first order.
	if _, ok := SignalToSummary(ProfileSignals{OrderCount: 0, FirstOrderAt: weeksAgo(5)}, bgnbdNow); ok {
		t.Error("zero orders should not be scorable")
	}
	if _, ok := SignalToSummary(ProfileSignals{OrderCount: 3, FirstOrderAt: nil}, bgnbdNow); ok {
		t.Error("nil first-order should not be scorable")
	}
	future := bgnbdNow.Add(time.Hour)
	if _, ok := SignalToSummary(ProfileSignals{OrderCount: 2, FirstOrderAt: &future}, bgnbdNow); ok {
		t.Error("first order in the future (T<=0) should not be scorable")
	}

	// t_x capped at T (defensive against last > now bookkeeping).
	badLast := bgnbdNow.Add(time.Duration(5 * float64(bgnbdWeek))) // 5 weeks in the future
	sum, ok = SignalToSummary(ProfileSignals{
		OrderCount: 3, FirstOrderAt: weeksAgo(20), LastOrderAt: &badLast,
	}, bgnbdNow)
	if !ok || sum.Tx > sum.T {
		t.Fatalf("t_x must be capped at T: %+v", sum)
	}
}

// Several orders with no elapsed repeat window form one purchase occasion, so
// x must be 0 whenever t_x is 0. The cases are orders sharing the first
// order's instant, a missing last-order timestamp, and a last order recorded
// before the first. A summary with x>0 and t_x=0 makes the BG/NBD likelihood
// unbounded as alpha→0 (see TestFitTenantBGNBD_SameInstantOrdersDoNotDegenerateFit).
func TestSignalToSummary_NoRepeatsWithoutRecency(t *testing.T) {
	for _, tc := range []struct {
		name string
		sig  ProfileSignals
	}{
		{"same instant", ProfileSignals{OrderCount: 4, FirstOrderAt: weeksAgo(12), LastOrderAt: weeksAgo(12)}},
		{"nil last order", ProfileSignals{OrderCount: 3, FirstOrderAt: weeksAgo(12), LastOrderAt: nil}},
		{"last before first", ProfileSignals{OrderCount: 2, FirstOrderAt: weeksAgo(12), LastOrderAt: weeksAgo(15)}},
		{"one order baseline", ProfileSignals{OrderCount: 1, FirstOrderAt: weeksAgo(12), LastOrderAt: weeksAgo(12)}},
	} {
		sum, ok := SignalToSummary(tc.sig, bgnbdNow)
		if !ok || sum.X != 0 || sum.Tx != 0 || math.Abs(sum.T-12) > 1e-6 {
			t.Errorf("%s: want one occasion {X:0 Tx:0 T:12}, got %+v ok=%v", tc.name, sum, ok)
		}
	}

	// A repeat order any positive time after the first is a real repeat.
	sum, ok := SignalToSummary(ProfileSignals{
		OrderCount: 2, FirstOrderAt: weeksAgo(12), LastOrderAt: weeksAgo(11),
	}, bgnbdNow)
	if !ok || sum.X != 1 || math.Abs(sum.Tx-1) > 1e-6 {
		t.Fatalf("repeat one week after the first should give x=1, t_x=1: %+v ok=%v", sum, ok)
	}
}

// makeSignals builds n varied repeat customers whose summaries are all valid,
// deterministically (index-derived, no randomness). Every fifth customer
// (i%5 == 0) has zero recency, and the multi-order ones among them are
// same-instant orders (33 when n = 200). The fit used to diverge on that
// shape (see TestFitTenantBGNBD_SameInstantOrdersDoNotDegenerateFit).
func makeSignals(n int) []ProfileSignals {
	out := make([]ProfileSignals, 0, n)
	for i := 0; i < n; i++ {
		orders := 1 + (i % 6)          // 1..6 orders
		ageWeeks := float64(20 + i%40) // 20..59 weeks old
		recencyWeeks := ageWeeks * float64(i%5) / 5.0
		out = append(out, ProfileSignals{
			Email:            "c" + string(rune('a'+i%26)),
			OrderCount:       orders,
			FirstOrderAt:     weeksAgo(ageWeeks),
			LastOrderAt:      weeksAgo(ageWeeks - recencyWeeks),
			HistoricCLVCents: 5000 * orders,
		})
	}
	return out
}

func TestFitTenantBGNBD_BelowThresholdFallsBack(t *testing.T) {
	fit := FitTenantBGNBD(makeSignals(MinCustomersForBGNBD-1), bgnbdNow)
	if fit.Fitted() {
		t.Errorf("a base of %d (< %d) should not fit", fit.Customers, MinCustomersForBGNBD)
	}
	// clv_bgnbd_fallback_test.go covers each fallback reason in full.
	if reason := fit.FallbackReason(); reason != BGNBDFallbackTooFewCustomers || fit.Customers != MinCustomersForBGNBD-1 {
		t.Errorf("fallback = %q with %d customers, want %q with %d",
			reason, fit.Customers, BGNBDFallbackTooFewCustomers, MinCustomersForBGNBD-1)
	}
}

func TestFitTenantBGNBD_FitsAboveThreshold(t *testing.T) {
	fit := FitTenantBGNBD(makeSignals(120), bgnbdNow)
	if !fit.Fitted() {
		t.Fatalf("a base of %d should fit: %v", fit.Customers, fit.Err)
	}
	if !fit.Params.Valid() {
		t.Fatalf("fitted params not valid: %+v", fit.Params)
	}
	if fit.Customers != 120 {
		t.Errorf("contributing count = %d, want all 120 customers", fit.Customers)
	}
	if reason := fit.FallbackReason(); reason != "" {
		t.Errorf("a fitted model reports fallback reason %q, want none", reason)
	}
}

// TestFitTenantBGNBD_SameInstantOrdersDoNotDegenerateFit pins the fix for a
// fit that diverged. makeSignals' base contains customers whose several
// orders share one timestamp. While they reached the fitter as x>0, t_x=0
// summaries, the likelihood had no maximum. Nelder-Mead then drove alpha to
// float underflow (5e-324 on darwin/arm64, 8e-309 on linux/amd64), and every
// forecast became architecture-dependent rounding noise. TestBGNBDForecastFor
// failed on linux/amd64 CI and passed on arm64 dev machines as a result.
func TestFitTenantBGNBD_SameInstantOrdersDoNotDegenerateFit(t *testing.T) {
	signals := makeSignals(200)
	fit := FitTenantBGNBD(signals, bgnbdNow)
	if !fit.Fitted() {
		t.Fatalf("a base of %d should fit: %v", fit.Customers, fit.Err)
	}
	params := fit.Params

	// Same-instant orders are one purchase occasion. The fit must therefore
	// be exactly the fit of the base where each such customer placed a
	// single order.
	merged := make([]ProfileSignals, len(signals))
	sameInstant := 0
	for i, s := range signals {
		merged[i] = s
		if s.OrderCount > 1 && s.LastOrderAt != nil && s.LastOrderAt.Equal(*s.FirstOrderAt) {
			merged[i].OrderCount = 1
			sameInstant++
		}
	}
	if sameInstant == 0 {
		t.Fatal("precondition: makeSignals must include same-instant multi-order customers")
	}
	mergedFit := FitTenantBGNBD(merged, bgnbdNow)
	if !mergedFit.Fitted() || mergedFit.Params != params {
		t.Errorf("same-instant orders changed the fit: %+v, want the single-order base's %+v (err=%v)",
			params, mergedFit.Params, mergedFit.Err)
	}

	// The fit must be non-degenerate. The population's mean latent purchase
	// rate r/alpha should be commensurate with the repeat rate the base
	// actually shows (repeat transactions per customer-week). The diverged
	// fit put r/alpha at 1e305 per week or more.
	var sumX, sumT float64
	for _, s := range signals {
		if summary, scorable := SignalToSummary(s, bgnbdNow); scorable {
			sumX += summary.X
			sumT += summary.T
		}
	}
	observed := sumX / sumT
	fitted := params.R / params.Alpha
	if !(fitted >= observed/10 && fitted <= observed*10) {
		t.Errorf("fitted mean purchase rate r/alpha = %g/week, want within 10x of the observed repeat rate %g/week (params %+v)",
			fitted, observed, params)
	}
}

func TestBGNBDForecastFor(t *testing.T) {
	fit := FitTenantBGNBD(makeSignals(200), bgnbdNow)
	if !fit.Fitted() {
		t.Fatalf("fit should succeed for the forecast test: %v", fit.Err)
	}
	params := fit.Params

	// A frequent, recently-active customer should have a strictly higher
	// forward forecast than a one-and-done customer of the same age.
	frequentRecent := ProfileSignals{
		OrderCount: 12, FirstOrderAt: weeksAgo(40), LastOrderAt: weeksAgo(1),
		HistoricCLVCents: 60000,
	}
	oneAndDone := ProfileSignals{
		OrderCount: 1, FirstOrderAt: weeksAgo(40), LastOrderAt: weeksAgo(40),
		HistoricCLVCents: 5000,
	}
	fr, ok1 := BGNBDForecastFor(params, frequentRecent, bgnbdNow, DefaultCLVHorizonWeeks)
	od, ok2 := BGNBDForecastFor(params, oneAndDone, bgnbdNow, DefaultCLVHorizonWeeks)
	if !ok1 || !ok2 {
		t.Fatal("both customers should be scorable")
	}
	if !(fr.PredictedOrders > od.PredictedOrders) {
		t.Errorf("frequent-recent (%.4f) should out-forecast one-and-done (%.4f)",
			fr.PredictedOrders, od.PredictedOrders)
	}
	if fr.PredictedOrders < 0 || od.PredictedOrders < 0 {
		t.Error("predicted orders must be non-negative")
	}

	// CLV scales with average order value: same behavior, double the spend.
	rich := frequentRecent
	rich.HistoricCLVCents = frequentRecent.HistoricCLVCents * 2
	richFc, _ := BGNBDForecastFor(params, rich, bgnbdNow, DefaultCLVHorizonWeeks)
	if richFc.PredictedCLVCents <= fr.PredictedCLVCents {
		t.Errorf("doubling avg order value should raise predicted CLV: %d vs %d",
			richFc.PredictedCLVCents, fr.PredictedCLVCents)
	}

	// Horizon 0 falls back to the default rather than forecasting nothing.
	def, _ := BGNBDForecastFor(params, frequentRecent, bgnbdNow, 0)
	if math.Abs(def.PredictedOrders-fr.PredictedOrders) > 1e-9 {
		t.Errorf("horizon 0 should default to %.0f weeks", DefaultCLVHorizonWeeks)
	}

	// A non-scorable signal returns ok=false.
	if _, ok := BGNBDForecastFor(params, ProfileSignals{OrderCount: 0}, bgnbdNow, 52); ok {
		t.Error("unscorable signal should return ok=false")
	}
}

// Splitting one checkout into several same-instant orders must not change
// the forecast. It is one purchase occasion worth the checkout's total, so
// both the expected transactions and the per-occasion spend behind the
// predicted CLV match a single order of the same total.
func TestBGNBDForecastFor_SameInstantOrdersAreOneOccasion(t *testing.T) {
	fit := FitTenantBGNBD(makeSignals(200), bgnbdNow)
	if !fit.Fitted() {
		t.Fatalf("fit should succeed for the forecast test: %v", fit.Err)
	}
	params := fit.Params
	split := ProfileSignals{
		OrderCount: 3, FirstOrderAt: weeksAgo(20), LastOrderAt: weeksAgo(20),
		HistoricCLVCents: 15000,
	}
	single := ProfileSignals{
		OrderCount: 1, FirstOrderAt: weeksAgo(20), LastOrderAt: weeksAgo(20),
		HistoricCLVCents: 15000,
	}
	fs, ok1 := BGNBDForecastFor(params, split, bgnbdNow, DefaultCLVHorizonWeeks)
	f1, ok2 := BGNBDForecastFor(params, single, bgnbdNow, DefaultCLVHorizonWeeks)
	if !ok1 || !ok2 {
		t.Fatal("both customers should be scorable")
	}
	if f1.PredictedCLVCents <= 0 {
		t.Fatalf("single-order forecast should predict positive CLV, got %+v", f1)
	}
	if fs != f1 {
		t.Errorf("split checkout forecast %+v, want the single-order forecast %+v", fs, f1)
	}
}
