// SPDX-License-Identifier: AGPL-3.0-only
package predictive

import (
	"fmt"
	"math"
	"math/rand"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/predictive_clv"
)

// TestFitTenantBGNBD_FitsBasesSettledAtTheRoundingFloor pins, through the
// production entry point, the fits that FitBGNBD's not_converged check
// rejected while it used Nelder-Mead's absolute tolerance as its test.
//
// In makeSignals' base dropout is nearly the same for every customer, so the
// maximum-likelihood fit lies on the ridge where a and b grow at a fixed
// ratio. There the log-likelihood carries rounding error far above the
// tolerance, and whether the simplex meets the tolerance before its budget
// runs out is chance. makeSignals repeats its pattern every 120 customers, so
// 240 and 600 customers have the 120 base's fit. Shuffling makeSignals(200)
// changes only the row order, which loadProfileSignals does not fix either
// (it has no ORDER BY), so each order has the 200 base's fit. With the
// tolerance as the test, darwin/arm64 fell back to the heuristic for 240 and
// 600 customers and for row order 6; linux/amd64, CI's architecture, for 600.
// Each rejected fit was the same fit as the accepted ones.
//
// A base that stops short of the tolerance runs the whole 2000-iteration
// budget, which under CI's -race -covermode=atomic costs several seconds per
// case. 1200 customers, the same fit again, are left to predictive_clv's
// Weight-10 case of TestFitBGNBD_AcceptsASearchSettledAtTheRoundingFloor.
func TestFitTenantBGNBD_FitsBasesSettledAtTheRoundingFloor(t *testing.T) {
	fitted := func(t *testing.T, signals []ProfileSignals) predictive_clv.Params {
		t.Helper()
		fit := FitTenantBGNBD(signals, bgnbdNow)
		if !fit.Fitted() {
			t.Fatalf("a base of %d customers on the dropout ridge fell back (%s): %v",
				fit.Customers, fit.FallbackReason(), fit.Err)
		}
		return fit.Params
	}
	ref120 := fitted(t, makeSignals(120))
	ref200 := fitted(t, makeSignals(200))

	for _, n := range []int{240, 600} {
		t.Run(fmt.Sprintf("%d customers", n), func(t *testing.T) {
			requireSameBGNBDFit(t, fitted(t, makeSignals(n)), ref120)
		})
	}
	for seed := int64(1); seed <= 6; seed++ {
		t.Run(fmt.Sprintf("200 customers, row order %d", seed), func(t *testing.T) {
			signals := makeSignals(200)
			rand.New(rand.NewSource(seed)).Shuffle(len(signals), func(i, j int) {
				signals[i], signals[j] = signals[j], signals[i]
			})
			requireSameBGNBDFit(t, fitted(t, signals), ref200)
		})
	}
}

// requireSameBGNBDFit fails the test unless got is the maximum-likelihood fit
// want is, as far as a forecast can tell: the same r and alpha, the same mean
// dropout probability a/(a+b), and the same 52-week forecast for a frequent,
// recent buyer. On the dropout ridge a and b are not identified separately,
// only their ratio is.
func requireSameBGNBDFit(t *testing.T, got, want predictive_clv.Params) {
	t.Helper()
	buyer := ProfileSignals{OrderCount: 12, FirstOrderAt: weeksAgo(40), LastOrderAt: weeksAgo(1), HistoricCLVCents: 60000}
	forecast := func(p predictive_clv.Params) float64 {
		f, ok := BGNBDForecastFor(p, buyer, bgnbdNow, DefaultCLVHorizonWeeks)
		if !ok {
			t.Fatal("precondition: the buyer is scorable")
		}
		return f.PredictedOrders
	}
	for _, c := range []struct {
		name      string
		got, want float64
		tolerance float64
	}{
		{"r", got.R, want.R, 1e-2},
		{"alpha", got.Alpha, want.Alpha, 1e-2},
		{"a/(a+b)", got.A / (got.A + got.B), want.A / (want.A + want.B), 1e-3},
		{"52-week forecast", forecast(got), forecast(want), 1e-3},
	} {
		if rel := math.Abs(c.got/c.want - 1); !(rel <= c.tolerance) {
			t.Errorf("%s = %.6g, want %.6g within a relative %g (fit %+v, reference %+v)",
				c.name, c.got, c.want, c.tolerance, got, want)
		}
	}
}
